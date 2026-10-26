/**
 * 出站地址白名单（SSRF 防护）的回归测试。
 *
 * 这个测试存在的理由：`baseUrl` 是**服务端替操作员发出的请求**。
 * 一旦允许它指向内网，一个控制台会话就等于一把内网钥匙 ——
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
 * 会返回云主机的临时凭据，`http://127.0.0.1:2375/containers/json` 能打到
 * 只监听本机的 Docker 接口。响应体会经由模型探测结果回显给调用方。
 *
 * 所以这里逐个断言**绕过写法**，而不只是断言"某个域名被拒"：
 * WHATWG URL 会把 `2130706433`、`0x7f.1` 归一成 `127.0.0.1`，
 * 把 `[::ffff:169.254.169.254]` 归一成 `[::ffff:a9fe:a9fe]` ——
 * 只看字符串前缀的实现会漏掉这些形式。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { checkOutboundUrl, parseHostAllowlist } from './urlGuard.js';

/** 断言被拒，并返回原因，便于确认拒的是**正确的那一条规则**。 */
function rejected(url: string): string {
  const verdict = checkOutboundUrl(url);
  assert.equal(verdict.allowed, false, `${url} 应当被拒绝`);
  assert.ok(verdict.reason && verdict.reason.length > 0, '拒绝时必须给出原因');
  return verdict.reason;
}

function allowed(url: string): void {
  const verdict = checkOutboundUrl(url);
  assert.equal(verdict.allowed, true, `${url} 应当被允许，实际被拒：${verdict.reason ?? ''}`);
}

test('云元数据地址（链路本地）被拒绝', () => {
  // 这是最值钱的一个目标：AWS/GCP/Azure 的实例凭据都在这里，且无需任何认证
  const reason = rejected('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
  assert.match(reason, /链路本地/);
});

test('别名形式的 169.254.169.254 同样被拒绝', () => {
  // 十进制整数、八进制、十六进制写法：URL 解析器归一化之后必须还是被拦下
  rejected('http://2852039166/latest/meta-data/');
  rejected('http://0xA9FEA9FE/latest/meta-data/');
  rejected('http://0251.0376.0251.0376/latest/meta-data/');
});

test('IPv4 回环与 "0.0.0.0" 被拒绝', () => {
  rejected('http://127.0.0.1:2375/containers/json');
  rejected('http://127.1.2.3/v1');
  rejected('http://2130706433/v1');
  rejected('http://0x7f.1/v1');
  rejected('http://0.0.0.0:8080/v1');
});

test('RFC1918 私有网段被拒绝', () => {
  rejected('http://10.0.0.5/v1');
  rejected('http://172.16.0.1/v1');
  rejected('http://172.31.255.254/v1');
  rejected('http://192.168.1.1/v1');
  // 边界：172.32 已经不在 RFC1918 里，不能误伤
  allowed('http://172.32.0.1/v1');
});

test('运营商级 NAT 网段被拒绝（部分云厂商的元数据服务在这里）', () => {
  const reason = rejected('http://100.100.100.200/latest/meta-data/');
  assert.match(reason, /100\.64\.0\.0\/10/);
  allowed('http://100.128.0.1/v1');
});

test('★ Oracle Cloud 元数据段 192.0.0.0/24 被拒绝（此前只有 192.168 有规则）', () => {
  /*
   * 修复前 `192.0.0.192` 落在**没有任何一条规则**的 192.0.0.0/24 里 ——
   * 而 OCI 的实例元数据服务就在那里，同样无需认证就返回实例凭据。
   * AWS（169.254.169.254）、阿里（100.100.100.200）、GCP 早已在表里，唯独 OCI 漏了。
   *
   * 整段都挡，而不是只列这一个端点：`192.0.0.x` 段内没有合法公网用途。
   */
  const reason = rejected('http://192.0.0.192/opc/v1/instance/');
  assert.match(reason, /Oracle Cloud|192\.0\.0\.0\/24/);
  rejected('http://192.0.0.123/v1');
  allowed('http://192.1.0.1/v1');
});

test('IPv6 回环、ULA、链路本地被拒绝', () => {
  rejected('http://[::1]:8080/v1');
  rejected('http://[fe80::1]/v1');
  rejected('http://[fd00::1]/v1');
  rejected('http://[ff02::1]/v1');
  // 公网 IPv6 不能误伤
  allowed('http://[2606:4700:4700::1111]/v1');
});

test('IPv4-mapped 与 NAT64 形式的内网地址被拒绝', () => {
  // 只看字符串前缀的实现会全部漏掉这四种写法
  rejected('http://[::ffff:169.254.169.254]/v1');
  rejected('http://[::ffff:127.0.0.1]/v1');
  rejected('http://[::127.0.0.1]/v1');
  rejected('http://[64:ff9b::a9fe:a9fe]/v1');
  // 内嵌公网 IPv4 的 mapped 地址不应被误伤
  allowed('http://[::ffff:8.8.8.8]/v1');
});

test('★ SIIT 写法 ::ffff:0:a.b.c.d 与 NAT64 隔离前缀 64:ff9b:1::/48 被拒绝', () => {
  /*
   * 这两条是**字节布局**层面的绕过，不是字符串层面的：
   *
   *   · SIIT（RFC 6145）把 ffff 放在 byte 8-9（`::ffff:0:7f00:0001`），
   *     与标准 IPv4-mapped 的 byte 10-11 不同 —— 只认后者的判定会整段放行。
   *   · NAT64 的嵌入位置随前缀长度移动（RFC 6052）：`64:ff9b::/96` 把 IPv4
   *     放在最后 32 位，RFC 8215 的 `64:ff9b:1::/48` 放在 byte 6-9。
   *     只按 /96 判定（要求 byte 4-11 全零）会漏掉 /48。
   *
   * 常规协议栈不把 SIIT 当回环落地（Linux 的 `ipv6_addr_v4mapped()` 同样只认
   * byte 10-11），所以现实可达性依赖部署里真有 SIIT/NAT64 转换器 —— 但纵深防御
   * 不该赌部署环境，识别成本只是多一条分支。
   */
  rejected('http://[::ffff:0:7f00:1]/v1'); // 内嵌 127.0.0.1
  rejected('http://[::ffff:0:a9fe:a9fe]/v1'); // 内嵌 169.254.169.254
  rejected('http://[64:ff9b:1::a9fe:a9fe]/v1'); // /48 前缀、IPv4 落在 byte 12-15
  rejected('http://[64:ff9b:1::7f00:1]/v1'); // 内嵌 127.0.0.1
  /*
   * ⚠️ 这两个变体让**两种嵌入位置都真的被走到**：上面的 `64:ff9b:1::a9fe:a9fe`
   * 命中 byte 12-15，而下面这条 `64:ff9b:1:a9fe:a9fe::` 命中 byte 6-9（IPv4
   * 放在 byte 6-9，尾部全零）。只测前者的话，byte 6-9 那条分支删掉也不会红 ——
   * 而"声称覆盖两个位置、实际只覆盖一个"正是本文件最初引入过的缺陷。
   */
  rejected('http://[64:ff9b:1:a9fe:a9fe::]/v1'); // /48 前缀、IPv4 落在 byte 6-9
  // 内嵌公网 IPv4 的这两种写法都不该误伤
  allowed('http://[::ffff:0:8888:8888]/v1');
  allowed('http://[64:ff9b:1::8888:8888]/v1');
  /*
   * ★ 反向回归守卫（2026-10-14 评审提出的真实缺陷）：NAT64 的 /48 部署里，
   * IPv4 落在 byte 6-9、尾部 byte 12-15 全零 —— 那一段全零的含义是「这里没放
   * IPv4」，**不是**「内嵌了 0.0.0.0」。若按后者判定，`blockedIpv4Reason` 会
   * 对全零返回「未指定地址」，于是这类**内嵌公网的合法地址被全部拒**，
   * NAT64 部署下所有 LLM 请求都失败。这几条钉住「全零尾段不误伤」这个行为。
   */
  allowed('http://[64:ff9b:1:8888:8888::]/v1'); // 内嵌公网 136.136.136.136
  allowed('http://[64:ff9b:1:8080:8080::]/v1'); // 内嵌公网 128.128.128.128
  /*
   * ★ 对照：byte 6-9 内嵌**私有**地址时必须拒 —— 与上面两条内嵌公网的放行合起来，
   * 钉住「同一个字节位置，判定跟着内嵌值的语义走」，而不是"看到全零尾段就拒"
   * 或"看到非零尾段就放"这类一刀切。
   */
  rejected('http://[64:ff9b:1:c0a8:1::]/v1'); // byte 6-9 = 192.168.0.1
});

test('★ NAT64 /96 的精确判定不被 /48 逻辑放松（尾部全零仍拒 0.0.0.0）', () => {
  /*
   * 评审的修法建议把两种前缀合并判定；但那会放松 /96 原有语义。/96 的前缀保证
   * byte 4-11 全零、IPv4 只可能在 byte 12-15，那一段全零**确实**代表内嵌 0.0.0.0，
   * 必须照旧拒。这条守住分支必须按前缀分开，而不是全当成"没内嵌"。
   */
  rejected('http://[64:ff9b::]/v1');
  allowed('http://[2606:4700:4700::1111]/v1'); // 对照：非 NAT64 的公网地址放行
});

test('localhost 与内部域名被拒绝（含结尾点写法）', () => {
  rejected('http://localhost:11434/v1');
  rejected('http://localhost./v1');
  rejected('http://api.internal/v1');
  rejected('http://metadata.google.internal/computeMetadata/v1/');
  rejected('http://printer.local/v1');
});

test('非 http(s) 协议被拒绝', () => {
  assert.match(rejected('file:///etc/passwd'), /http/);
  rejected('gopher://127.0.0.1:70/');
  // 大小写与空值
  rejected('');
  rejected('not a url');
});

test('正常的公网端点全部放行', () => {
  // 自定义端点是有意保留的功能：自建网关、代理、兼容层。白名单必须不能把它们挡掉
  allowed('https://api.deepseek.com/v1');
  allowed('https://api.openai.com/v1');
  allowed('https://openrouter.ai/api/v1');
  allowed('https://generativelanguage.googleapis.com/v1beta');
  allowed('http://gateway.example.com:8080/v1');
  // 主机名里含数字 / 连字符不能误判成 IP
  allowed('https://llm-2.example.com/v1');
});

/* -------------------------------------------------------------------------- */
/*  内网白名单（2026-10-11：用户要连自建的内网 LLM 服务）                        */
/* -------------------------------------------------------------------------- */

test('★ 默认仍然挡掉私网 —— 白名单不能改变默认行为', () => {
  /*
   * 用户要把 baseUrl 指向自己内网的 LLM 服务（`http://172.19.0.1:8317/v1`）。
   * 放行必须**由操作员显式声明**：不传白名单时，行为与从前**完全一致**。
   *
   * 这一条是整套改动的地基 —— 如果哪天它红了，说明"默认安全"被悄悄改掉了。
   */
  for (const url of [
    'http://172.19.0.1:8317/v1',
    'http://10.0.0.5:8080/v1',
    'http://192.168.1.10/v1',
    'http://127.0.0.1:11434/v1',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    assert.equal(checkOutboundUrl(url).allowed, false, `★ ${url} 默认必须被挡`);
  }
});

test('★ 显式声明的内网目标才放行 —— 且只放行它', () => {
  const list = parseHostAllowlist('172.19.0.1');
  assert.equal(checkOutboundUrl('http://172.19.0.1:8317/v1', list).allowed, true, '声明过的主机应放行');

  /*
   * ⚠️ **关键：放行一个地址，不能顺带放行云元数据。**
   * 这正是"不直接放开私网、而要做显式清单"的全部理由。
   */
  assert.equal(
    checkOutboundUrl('http://169.254.169.254/latest/meta-data/', list).allowed,
    false,
    '★ 声明 172.19.0.1 不能顺带允许元数据地址',
  );
  assert.equal(checkOutboundUrl('http://172.19.0.2/v1', list).allowed, false, '同网段的其他主机也不该被放行');
});

test('CIDR / 域名后缀 / 主机名的写法都生效', () => {
  assert.equal(checkOutboundUrl('http://172.19.5.9/v1', parseHostAllowlist('172.19.0.0/16')).allowed, true);
  assert.equal(checkOutboundUrl('http://172.20.5.9/v1', parseHostAllowlist('172.19.0.0/16')).allowed, false);
  assert.equal(checkOutboundUrl('http://gw.corp.lan/v1', parseHostAllowlist('.corp.lan')).allowed, true);
  assert.equal(checkOutboundUrl('http://localhost:11434/v1', parseHostAllowlist('localhost')).allowed, true);
  /* 空白/逗号分隔都要认 —— 手输的清单不该因为分隔符而静默失效。 */
  assert.equal(parseHostAllowlist('172.19.0.1, 10.1.2.3').length, 2);
  assert.equal(parseHostAllowlist('  172.19.0.1   10.1.2.3 ').length, 2);
});

test('白名单不能绕过协议校验', () => {
  /* 协议校验在白名单之前 —— 声明了主机也不该让 file: 通过。 */
  assert.equal(checkOutboundUrl('file:///etc/passwd', parseHostAllowlist('localhost')).allowed, false);
});
/* -------------------------------------------------------------------------- */
/*  部署模板必须露出白名单开关（2026-10-27）                                      */
/* -------------------------------------------------------------------------- */

test('★★★ 两个 .env.example 都必须提到 ALLOW_PRIVATE_LLM_HOSTS', () => {
  /*
   * ## 为什么这条测试存在
   *
   * 白名单是**唯一**能让内网端点工作的开关，但它在两个 `.env.example` 里
   * **都没出现过**（`docs/archive/TRIAGE-20261013-external-issues.md` 记录了
   * 这个缺口，连续几十轮"已记录未推进"）。
   *
   * 后果是用户实际撞上的形态：
   *
   *     在「添加 AI 模型」里填 http://127.0.0.1:3425/v1
   *     → 红色「连接失败：baseUrl 不被允许：回环地址 127.0.0.0/8」
   *     → 翻遍 `.env.example` 找不到任何开关
   *     → 只能把这条报错当成 bug
   *
   * ⚠️ 这不是"用户没读文档"—— **模板里根本没有这一项**。
   * 一个受支持的功能如果只在源码注释里存在，对使用者就等于不存在。
   *
   * 这条测试钉住的是"模板里有这一项"，不是它的具体取值 ——
   * 默认留空（全挡）仍然是正确的安全姿态。
   */
  for (const rel of ['../../../../.env.example', '../../../../deploy/.env.example']) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(
      text,
      /^ALLOW_PRIVATE_LLM_HOSTS=/m,
      `★ ${rel} 里必须有 ALLOW_PRIVATE_LLM_HOSTS 这一项（留空即可），` +
        '否则内网端点这个受支持的功能在部署模板里完全不可见。',
    );
  }
});
