/**
 * Trader dashboard tables: 当前持仓 / 当前委托 / 历史成交 / 订单记录.
 *
 * Two rules hold for every table in this file, and both come from DESIGN.md §6:
 *
 * 1. **Never render an unbounded list.** 当前持仓受 `maxPositions` 天然约束，
 *    所以最多渲染 `MAX_ROWS` 行、并在页脚说明被截断了。历史成交与订单记录**没有**
 *    天然上界（每下一次单、每平一次仓就多一行），所以它们改成**游标分页**：
 *    第一页 25 行，滚到表格底部才取下一页，一直翻到服务端返回不满一页为止 ——
 *    见 `useTablePaging`。这两张表以前每 15 秒无条件向服务端要 200 行并全部渲染。
 * 2. **Horizontal scrolling stays inside the table.** Every table sits in a
 *    `.scroll-x` box, so a 14-column order table never pushes the page wide
 *    (the shell has `overflow-x-hidden` and would otherwise clip it).
 *
 * The close controls are deliberately *not* wired to an API call — the backend
 * has no manual-close endpoint. Pressing one opens an explanation of how the
 * bot actually closes positions rather than pretending a request was sent.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { LoaderCircle } from 'lucide-react';
import { exchangeErrorLabel, type MarginMode, type OrderRecord, type PositionView, type TradeRecord } from '@aq/shared';
import { orderPurposeLabel, orderStatusLabel, orderTypeLabel } from '@aq/shared';
import { api } from '../lib/api';
import { needsReconcileFlag, reconcileNoteTitle } from '../lib/orderFlags';
import { useEvents } from '../lib/store';
import { usePolled } from '../lib/hooks';
import { Badge, Button, ErrorNote, Modal, Panel, Spinner3 } from './ui';
import { SideBadge } from './Badges';
import { closeReasonLabel } from '../lib/summaries';
import {
  NET_PNL_FORMULA,
  PnlBreakdown,
  pnlFormulaText,
  tradeCosts,
  type PnlCosts,
} from './PnlBreakdown';
import { BALANCE_LABEL, fmtDateTime, fmtDuration, fmtPercent, fmtPrice, fmtQty, fmtSigned, fmtUsd, fmtUsdSigned, marginModeLabel, orderMarginMode, pnlColor, symbolTone, symbolToneWithAvoidance } from '../lib/format';
import { summarizeClose } from '../lib/closeSummary';
import { pickPositions } from '../lib/pickPositions';

/* -------------------------------------------------------------------------- */
/*  Row caps                                                                   */
/* -------------------------------------------------------------------------- */

/** 当前持仓表渲染多少行。持仓数受 `maxPositions` 约束，不需要分页。 */
const MAX_ROWS = 100;

/**
 * 历史成交 / 订单记录第一页多少行，以及"滚到底再取下一页"的页大小。
 *
 * 25 是"一屏左右"：比一屏多一点，所以第一眼就能看出下面还有东西；又足够小，
 * 一次请求与一次渲染都不可能有感知。这两张表以前一次要 200 行 ——
 * 操作者的原话是"成千上万数据一次加载出来导致系统卡死"。
 */
const PAGE_SIZE = 25;

/**
 * 每页向服务端**多要一条**，只用来判断"还有没有更早的"。
 *
 * 响应体是 `OrderRecord[]` / `TradeRecord[]`（形状没变：老客户端与 `docs/API.md`
 * 都照旧），数组里没有"还有下一页吗"这个字段，所以多要一条是最便宜的探针：
 * 拿到 26 条 = 还有更早的；拿到 ≤25 条 = 已经到最早一笔了。
 * 不这么做就只能靠"再请求一次、拿到空数组"来判断终点 —— 那时"加载中"会先多闪一下，
 * 而终点提示也总是迟一步。决策流（`DecisionFeed`）用的是同一套办法。
 */
const PAGE_LIMIT = PAGE_SIZE + 1;

/* -------------------------------------------------------------------------- */
/*  Cursor pagination shared by the two history tables                         */
/* -------------------------------------------------------------------------- */

/** 「加载更多」的状态机：与决策流一致（idle / loading / error / done）。 */
type MoreState = 'idle' | 'loading' | 'error' | 'done';

/** `usePolled` 那一份数据里，这个组件关心的三个字段。 */
interface PolledPage<T> {
  data: T[] | null;
  loading: boolean;
  error: string | null;
  /**
   * 这个 hook **成功拿到过数据**的时刻（`usePolled` 里 `updatedAt`）。
   * `null` = 从没成功过。用来区分"还没有数据"与"有数据但正在刷新"。
   */
  updatedAt: number | null;
}

/**
 * 延迟显示加载转圈。
 *
 * ## 为什么需要它：**转圈"出现又消失"本身就是一种闪烁**
 *
 * 用户报的现象是「点进当前委托会闪一下，太快看不清」。逐帧实测量到的真实序列是：
 *
 *     2781ms  行=-1   ← 出现「正在加载委托…」
 *     3575ms  行= 4   ← 800ms 后被真实的行替换
 *
 * 也就是说：转圈本身**没有错**（那一刻数据确实还没到），但**它存在过再消失**，
 * 眼睛就会捕捉到这次跳变。而"加载很快"的场景里，这个转圈提供的信息远小于它造成的干扰。
 *
 * 做法：**只有加载真的超过阈值才显示它**。快的时候表格区域短暂空白 —— 人眼感知不到；
 * 慢的时候才给出"正在加载"的反馈，否则用户会以为界面卡住了。
 *
 * 阈值 350ms 的取法：低于它，人会把"空白 → 内容"当成一次性出现；高于它，就该有反馈。
 */
function useDelayedSpinner(active: boolean, delayMs = 350): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!active) {
      setShow(false);
      return;
    }
    const timer = window.setTimeout(() => setShow(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return show;
}

/** 一页怎么取。两张表的差别只有一个 API 函数，所以做成参数。 */
type PageFetcher<T> = (

  traderId: number,
  options: {
    limit: number;
    before?: number | null;
    /**
     * **时间游标**：只看成交表。它的 `id` 是插入顺序，而**对账补录的行 id 更大、
     * 成交时刻更早** —— 按 id 排序会让日期看起来错乱（用户报过），所以服务端
     * 改成按 `closed_at` 排序，而按时间排序之后只用 id 做游标会漏行。
     * 订单表不传它，行为与以前完全一致。
     */
    beforeClosedAt?: string | null;
    signal?: AbortSignal;
  },
) => Promise<T[]>;

interface TablePaging<T> {
  /** 屏幕上要渲染的全部行：轮询的第一页 + 翻出来的每一页 + 推送进来的实时行，按 id 倒序去重。 */
  rows: T[];
  loading: boolean;
  /**
   * **是否曾经成功拿到过数据**（一旦为 true 就永远是 true）。
   *
   * ⚠️ **它和 `loading` 是两件事，用途也不同。**
   *
   * `loading` 来自 `usePolled`，语义是"**本次请求还在飞**"—— 组件重新挂载时它会
   * 从 `true` 重新开始。**拿它单独决定"要不要显示转圈"会闪**：
   *
   *   实测（刷新页面后在 150ms 内点「当前委托」）：转圈持续了 **8 帧（约 400ms）**
   *   才被 3 行数据替代。用户的原话是「会错误、闪烁出现一些数据（闪太快看不清）」；
   *   而在标签之间来回切时**不会**出现 —— 因为那时组件不重挂、`loading` 早已是 false。
   *
   * 有它之后，加载态只在**真的什么都没有**时出现：数据一旦到过手上，就算下一轮
   * 轮询在飞，表格也照旧显示手里的行，而不是退回一个转圈。
   */
  hasLoadedOnce: boolean;
  error: string | null;
  /** 还有没有更早的行（决定要不要挂观察器、要不要显示「已到最早一笔」）。 */
  hasMore: boolean;
  moreState: MoreState;
  moreError: string | null;
  /** 错误行里的「重试」按钮走它。 */
  retry: () => void;
  /** 表格**自己的**滚动框，给 `IntersectionObserver` 当 `root`。 */
  scrollerRef: MutableRefObject<HTMLDivElement | null>;
  /** 观察哨兵：列表末尾 1px 高的元素。 */
  sentinelRef: MutableRefObject<HTMLDivElement | null>;
}

/**
 * 把一批新行并进"已经拿到"的那一份，**按 id 去重**。
 *
 * 没有新行时返回**原数组**（而不是一个新数组）：`useState` 的 setter 拿到同一个引用会
 * 直接跳过这次重渲染，而轮询每 15 秒都会调一次这里 —— 绝大多数时候一条新的都没有。
 *
 * 去重不是可选的：轮询的第一页与翻出来的页在边界上必然重叠一行（探针行那一行
 * 会作为下一页的第一条被取回来），WebSocket 推送又可能同一行再来一份。
 */
function mergeById<T extends { id: number }>(prev: T[], rows: T[]): T[] {
  const seen = new Set(prev.map((row) => row.id));
  const fresh = rows.filter((row) => !seen.has(row.id));
  return fresh.length > 0 ? [...prev, ...fresh] : prev;
}

/**
 * 历史成交 / 订单记录的**游标分页**，两张表共用。
 *
 * ## 游标是 `before=id`，不是 `offset`
 *
 * 这两张表都是**在顶部持续插入**的（每下一单、每平一仓就多一行）。用偏移量翻页时，
 * 只要两次请求之间又落了一行，第二页的起点就整体后移一格 —— 第二页的第一条会和
 * 第一页的最后一条**重复**（同一笔成交在表格里出现两次，而这张表的数字是钱）。
 * 游标锚在一条具体行上：新行的 `id` 一定更大、永远落在游标之上。
 * 理由的完整版写在服务端 `repositories.ts` 的 `orders.list()` / `trades.list()` 上。
 *
 * ## `root` 是**表格自己的滚动框**，不是窗口
 *
 * 这两张表的滚动条在 `<div class="scroll-x max-h-[34vh] overflow-y-auto">` 里
 * （见下面两张表的 JSX）：内容超过 60vh 之后由**它**滚，而不是页面滚
 * （`Layout.tsx` 的内容区虽然在 `xl` 以上也让主栏自己滚，但表格自己有 `max-h`，
 * 永远轮不到主栏去滚表格里的行）。用默认的视口当 `root` 会比错对象：
 * 表格中段的哨兵在视口里而没在容器底部，于是"没滚到底就开始加载下一页"，
 * 甚至一次把整段历史都拉进来。所以这里必须显式传 `root`。
 *
 * 若表格内容还不足 60vh（一开始只有 25 行时常常如此），容器没有可滚的余量、
 * 哨兵本来就落在容器的可视区里，于是会**自动接着取下一页**，直到内容撑满
 * 那个高度为止 —— 这是想要的：先把盒子填满，再等操作者滚动。
 *
 * ## 轮询与分页的相互作用（这里最容易做错）
 *
 * - 轮询只负责**最新的一页**：`usePolled` 每 15 秒重拉第一页，它并进"已经拿到的那些行"。
 *   已经翻出来的更早的页**原封不动** —— 把轮询结果直接替换掉列表，等于每 15 秒丢掉
 *   操作者翻出来的全部历史（他正读到第 60 行，一眨眼又回到 25 行）。
 * - 把轮询的第一页当成一个"固定窗口"（每次替换掉旧的）同样是**错的**：新行一插进来，
 *   窗口里最旧的那一条就被挤出去，而它恰好是和已加载历史相接的那一条 ——
 *   列表中间会静默少一行（长度还看不出来）。所以这里只做累加，见 `mergeById`。
 * - 合并按 `row.id` 去重，所以同一行既在 REST 结果里、又在 WebSocket 推送里，
 *   或者同时落在两页的边界上，都只会渲染一次。
 * - 分页状态（已加载的页、游标、滚动位置）全是**组件自己的状态 + 真实 DOM 滚动位置**，
 *   轮询返回不会重置任何一个。换机器人时整套丢掉（见下面的 `useEffect`）。
 */
function useTablePaging<T extends { id: number; traderId: number }>(
  traderId: number,
  fetchPage: PageFetcher<T>,
  polled: PolledPage<T>,
  live: T[] | undefined,
  /**
   * 这一行在**时间轴**上的位置。省略 = 按 `id` 排序（订单表就是对的：
   * 订单的 id 顺序与创建顺序一致）。
   *
   * ⚠️ **成交表必须传**（`(row) => row.closedAt`）：成交的 `id` 是插入顺序，
   * 而**对账补录的行 id 更大、成交时刻却更早** —— 实测 18 行里 4 处乱序，
   * 界面上就是"日期显示错乱"（用户的原话）。
   */
  timeOf?: (row: T) => string,
  /**
   * 「这张表的 DOM 会被**原样重挂**」的信号：值一变，观察器就重新挂一次。
   *
   * ⚠️ **为什么必须有它**（订单表就是这么坏的）：`TraderTables` 里两处 `OrdersTable`
   * 写在 JSX 的两个不同位置上（「当前委托」与「订单记录」各一个），`tab` 一变，
   * React 把其中一个**卸载**、另一个**新挂**—— 而 `paging` 状态在容器里，所以这件事
   * 对容器是无声的：`scrollerRef` / `sentinelRef` 悄悄指到了新节点上，可观察器 effect
   * 的依赖（`hasMore` / `moreState` / `traderId` / `listMounted`）一个都没变，
   * **effect 不会重跑** → 新哨兵没有任何观察者 → 切一次标签，"滚到底加载更早的记录"
   * 就静默失效（而它看起来只是"下面没有了"）。
   *
   * 同一个道理的另一面正是这次加收起交互时要躲开的坑：**任何让 ref 与观察器分家的改动，
   * 都会让哨兵要么没人看，要么被误判成可见、一次把整段历史拉进来**。
   */
  remountKey?: unknown,
): TablePaging<T> {
  /**
   * 服务端给过的、**已经显示出来的**行（按 id 去重；轮询的第一页与翻出来的每一页都并进来）。
   *
   * 增长有界且很慢：轮询只在真的出现新行时 +1，翻页每次 +25，而且只有操作者
   * 自己滚到底（或盒子还没被填满）才会发生。
   */
  const [loaded, setLoaded] = useState<T[]>([]);
  const [moreState, setMoreState] = useState<MoreState>('idle');
  const [moreError, setMoreError] = useState<string | null>(null);
  /** 最近一次"下一页"是不是满页 —— 终点提示靠它判断。 */
  const [deeperFull, setDeeperFull] = useState(false);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /** 在途的"加载更多"请求：换机器人或卸载时要作废掉。 */
  const moreAbortRef = useRef<AbortController | null>(null);
  /** 取页函数的引用：让它不进 `loadMore` 的依赖，避免每次渲染都换一个新的回调。 */
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  /** 当前机器人 id 的快照：异步回调里用它判断响应是不是已经属于上一个机器人了。 */
  const traderIdRef = useRef(traderId);
  traderIdRef.current = traderId;

  useEffect(() => {
    // 换机器人：已加载的旧页、错误与终点标记都属于上一个机器人，整套丢掉。
    // 清理函数把在途请求也 abort 掉 —— 否则它回来时会追加到新机器人的列表里。
    setLoaded([]);
    setMoreState('idle');
    setMoreError(null);
    setDeeperFull(false);
    return () => moreAbortRef.current?.abort();
  }, [traderId]);

  /*
   * 轮询拿到的第一页并进来。
   *
   * 第一页同样是"多要一条"：最后那一条只是探针（回答"还有没有更早的"），不显示，
   * 所以这里切掉。
   *
   * ⚠️ **`traderId` 过滤已删**（2026-10-17 · 台账 FRD-05）：`usePolled` 现在在
   * `deps` 变化时自己清 `data`，"上一家的订单被并进新列表"从协议层就不可能发生。
   */
  useEffect(() => {
    const page = polled.data;
    if (!page) return;
    const rows = page.slice(0, PAGE_SIZE);
    if (rows.length === 0) return;
    setLoaded((prev) => mergeById(prev, rows));
  }, [polled.data, traderId]);

  /**
   * 轮询的第一页 + 更早的页 + 推送进来的实时行 → 一个列表，**按 id 倒序**。
   *
   * 去重靠 `Map` 的键（就是 id）：同一行同时出现在两页边界上、或者既在 REST
   * 结果里又在 WebSocket 推送里，都只会渲染一次。订单与成交写入后不再修改
   * （`status` 变化会由下一次轮询覆盖同一 id 的那一份），所以旧行永远不需要重拉。
   *
   * 轮询刚拿到的第一页也**直接**并进来，不等上面那个 effect 落地：否则"数据到了"和
   * "列表挂上去了"会差一次重渲染，而挂在列表末尾的哨兵观察器只在这几个依赖变化时
   * 重新挂载 —— 它会永远挂不上，滚到底毫无反应（决策流那侧实测到过这个情形）。
   */
  const rows = useMemo(() => {
    const merged = new Map<number, T>();
    for (const row of loaded) merged.set(row.id, row);
    for (const row of live ?? []) if (row.traderId === traderId) merged.set(row.id, row);
    for (const row of (polled.data ?? []).slice(0, PAGE_SIZE)) merged.set(row.id, row);
    const all = [...merged.values()];
    /*
     * ⚠️ **成交表按时间排，订单表按 id 排。**
     *
     * 成交的 `id` 是插入顺序，而**对账补录的行 id 更大、成交时刻更早** ——
     * 按 id 排会让界面上的日期跳来跳去（用户原话：「历史成交里面日期显示错乱」）。
     * 订单没有这个问题：它的 id 顺序与创建顺序一致，补录也不改顺序。
     */
    return timeOf
      ? all.sort((a, b) => {
          const ta = timeOf(a);
          const tb = timeOf(b);
          return ta === tb ? b.id - a.id : tb.localeCompare(ta);
        })
      : all.sort((a, b) => b.id - a.id);
  }, [loaded, polled.data, live, traderId, timeOf]);

  /**
   * 下一页的游标 = **手里最小的 id**，也就是"比我现在有的都更早"。
   *
   * 只统计**服务端给过的行**（已加载的 + 本轮轮询的第一页），不含推送：
   * 推送来的行是"最新的那些"，服务端那一份才是连续的，游标必须锚在连续的那一段上。
   * 被切掉的那条探针行 id 比游标更小，所以下一次翻页会把探针行当作新一页的第一条
   * 正常取回来 —— 不重不漏，代价只是每次多取一行。
   */
  const cursor = useMemo(() => {
    /*
     * 游标 = **手里最早的那一行**。按 id 排时取最小 id；按时间排时取最早的时刻
     * （两者都要带上 id：同一毫秒上可能有多行，服务端的复合游标靠 id 破平）。
     */
    let earliest: T | null = null;
    const consider = (row: T): void => {
      if (earliest === null) {
        earliest = row;
        return;
      }
      const older = timeOf ? timeOf(row) < timeOf(earliest) : row.id < earliest.id;
      if (older) earliest = row;
    };
    for (const row of loaded) consider(row);
    for (const row of (polled.data ?? []).slice(0, PAGE_SIZE)) consider(row);
    return earliest as T | null;
  }, [loaded, polled.data, timeOf]);

  /**
   * 还有没有更早的。
   *
   * - 服务端给过一个**不满一页**的下一页（`done`）→ 没有；
   * - 最近一次下一页是满页，或者轮询的第一页是满的（说明下面还有）→ 有；
   * - 第一页本来就不满 26 条 → 没有了，直接显示终点。
   */
  const hasMore = moreState !== 'done' && (deeperFull || (polled.data?.length ?? 0) > PAGE_SIZE);

  /**
   * 取下一页（更早的 25 行），追加到下面。
   *
   * 游标是"手里**最旧的那一行**"，不是偏移量，所以**不会**因为这会儿又落了一单而错位：
   * 新行一定落在游标**之上**（id 更大、时间更新）。
   *
   * ⚠️ **成交表要同时给 `beforeClosedAt`**：服务端按 `closed_at` 排序，
   * 而补录行的 id 更大、时间更早 —— 只用 id 做游标会把它们整个跳过（页边界漏行）。
   */
  const loadMore = useCallback(async (opts?: { silent?: boolean }) => {
    if (moreState === 'loading' || moreState === 'done') return;
    if (cursor === null) {
      // 手里一行都没有 = 没有可翻的页（第一页还没到）。落一个终态而不只是 return：
      // 重试按钮走的是同一条路径，这里若不落终态，用户会停在一个点了没反应的"重试"上。
      setMoreState('done');
      return;
    }

    const requestedFor = traderId;
    moreAbortRef.current?.abort();
    const controller = new AbortController();
    moreAbortRef.current = controller;
    /*
     * ⚠️ **自动填充视口时不进入 `loading` 状态**（`silent`）。
     *
     * 这是用户报的那个"不停闪烁"的根因。表格刚挂上时只有 3 行、视口远没填满，
     * 哨兵一直在观察范围内，于是：
     *
     *     观察器挂上 → 立刻 loadMore → moreState: idle→loading→idle
     *       → effect 重跑 → 观察器又挂 → 又立刻 loadMore → …… 直到「已到最早一笔」
     *
     * 每循环一轮，底部那句「正在加载更早的订单…」就出现又消失一次 —— 用户的原话是
     * 「页面不停闪烁／加载」。而他并没有滚，这个提示本来就不该出现。
     *
     * `silent` 只跳过 `loading` 这个**可见状态**，请求照发、防重入照旧
     * （`moreAbortRef` 与下面的 abort 判断都不受影响）。
     */
    if (!opts?.silent) setMoreState('loading');
    setMoreError(null);

    try {
      const page = await fetchRef.current(requestedFor, {
        limit: PAGE_LIMIT,
        before: cursor.id,
        ...(timeOf ? { beforeClosedAt: timeOf(cursor) } : {}),
        signal: controller.signal,
      });
      // 机器人已经切走（或组件已卸载）：这一页属于上一个列表，直接丢掉。
      if (controller.signal.aborted || traderIdRef.current !== requestedFor) return;

      // 显示前 25 条，最后那条探针留给下一次翻页（它会成为新一页的第一条）。
      setLoaded((prev) => mergeById(prev, page.slice(0, PAGE_SIZE)));
      setDeeperFull(page.length > PAGE_SIZE);
      // 不满一页 = 已经到最早一笔。那条"多要一条"的探针就是为这一句存在的。
      setMoreState(page.length > PAGE_SIZE ? 'idle' : 'done');
    } catch (error) {
      if (controller.signal.aborted) return;
      // 失败**必须**看得见并且能重试：静默停下会让操作者以为"历史只有这么多"。
      setMoreError((error as Error).message);
      setMoreState('error');
    }
  }, [cursor, moreState, traderId, timeOf]);

  /** 观察器回调里用的永远是**最新一次渲染**的 `loadMore`（否则会拿着旧游标再请求一次）。 */
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  /** 表格（滚动框与哨兵）有没有挂上去 —— 观察器要在它出现的那一次重新挂。 */
  const listMounted = rows.length > 0;

  /**
   * 滚到表格底部就取下一页。
   *
   * `root` 必须是表格**自己的滚动框**（理由见 `useTablePaging` 顶部"root"那一节）。
   * `rootMargin` 往下放 240px ≈ 提前几行开始取：滚到最后一行时下一页往往已经拼在
   * 下面了，"正在加载…"不会先闪一下再被内容顶走。
   */
  useEffect(() => {
    /*
     * 只在"还有更早的、而且此刻既没在加载也没出错"时观察：
     * - 加载中不观察：哨兵还在容器视口里，重新观察会立刻再触发一次，打出重复请求；
     * - 出错后不观察：能失败一次的请求会一直失败，自动重试就变成打不停的循环。
     *   这时改由错误行里的"重试"按钮驱动，用户点一次才发一次。
     */
    if (!hasMore || moreState !== 'idle') return;
    const root = scrollerRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        /*
         * 滚动框**还没被填满**（`scrollHeight <= clientHeight`）说明这不是"用户滚到底"，
         * 而是"表格太短、哨兵一开始就可见"。那种情况下静默加载 —— 否则每轮都会让底部
         * 那句「正在加载更早的订单…」闪一次（用户报的闪烁就是这么来的）。
         */
        const notScrollable = root.scrollHeight <= root.clientHeight + 2;
        void loadMoreRef.current({ silent: notScrollable });
      },
      { root, rootMargin: '240px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    /*
     * `listMounted` 必须在依赖里：`hasMore` 变真的那一次提交里，表格可能还没挂上去
     * （数据先到、渲染列表用的状态后到），`scrollerRef.current` 还是 null，
     * 观察器就永远不会被创建。`traderId` 同理：换机器人之后要重新观察新的滚动框。
     *
     * `remountKey` 解决的是第三种情形：节点**被换掉了**而上面几个依赖都没变
     * （切「当前委托」/「订单记录」标签）。见该参数上的说明。
     */
  }, [hasMore, moreState, traderId, listMounted, remountKey]);

  /*
   * 把视口钉住：新行插到表格**顶部**时不把正在读的内容顶走。
   *
   * 这两张表每 15 秒轮询一次，机器人每下一单 / 每平一仓就会在最上面多一行。
   * 操作者正往下翻着看历史时，顶部插进来的那一行会把整张表往下推 ——
   * 屏幕上的字会突然跳一下，"我正在看的那一单"就跑掉了。
   *
   * 做法：拿上一次提交时的**第一行**当锚点（`data-row-id` 是它的 DOM 标记），
   * 量出它这次被推下去了多少像素，就把 `scrollTop` 加同样多。离开顶部才补偿 ——
   * 停在顶部时新行本来就该出现在眼前。
   *
   * 用 `getBoundingClientRect()` 而不是 `offsetTop`：`<tr>` 的 offsetParent 在表格里
   * 并不一定是滚动框，rect 是相对视口的，做差之后与是哪个 offsetParent 无关。
   */
  const geomRef = useRef<{ id: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const anchor = geomRef.current;
    if (anchor && el.scrollTop > 4) {
      const node = el.querySelector<HTMLElement>(`[data-row-id="${anchor.id}"]`);
      if (node) {
        const delta = node.getBoundingClientRect().top - anchor.top;
        if (delta > 0) el.scrollTop += delta;
      }
    }

    // 重新取锚点：第一**行**（表头不是行，没有这个标记），它在下一次提交里依然存在
    // （列表按 id 去重、已加载的行不会消失）。
    const first = el.querySelector<HTMLElement>('[data-row-id]');
    geomRef.current = first ? { id: Number(first.dataset.rowId), top: first.getBoundingClientRect().top } : null;
  }, [rows]);

  return {
    rows,
    loading: polled.loading,
    hasLoadedOnce: polled.updatedAt !== null,
    error: polled.error,
    hasMore,
    moreState,
    moreError,
    /* 重试是**用户明确点的**，所以不静默 —— 他要看到"正在加载"。包一层是因为
       `loadMore` 现在收 `opts`，直接传引用会把点击事件当成参数塞进去。 */
    retry: () => void loadMore(),
    scrollerRef,
    sentinelRef,
  };
}

/**
 * 表格末尾那几行状态：哨兵 + 加载中 + 失败可重试 + 终点。
 *
 * 三件都要看得见。一个"滚到底就没反应了"的加载更多比没有加载更多更糟 ——
 * 操作者会以为历史只有这么多，而事实是刚才那次请求没成功。
 */
function PageTail({
  sentinelRef,
  hasMore,
  moreState,
  moreError,
  onRetry,
  noun,
}: {
  sentinelRef: MutableRefObject<HTMLDivElement | null>;
  hasMore: boolean;
  moreState: MoreState;
  moreError: string | null;
  onRetry: () => void;
  /** 加载文案里的名词：`订单` / `成交`。 */
  noun: string;
}) {
  return (
    <>
      {/*
        哨兵：它进入滚动框的视口（`rootMargin` 提前约 240px）就取下一页。
        放在表格**最后**，所以只有操作者读到最下面时才会触发。
        `h-px` 而不是 `h-0`：零高度的元素在部分浏览器里会被当成"没有盒子"、
        永远不产生交叉，给它 1px 就没有这个歧义（视觉上仍然看不见）。
      */}
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />

      {moreState === 'loading' && (
        <p
          role="status"
          className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-ink-faint"
        >
          <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
          正在加载更早的{noun}…
        </p>
      )}

      {moreState === 'error' && (
        <p role="alert" className="px-3 py-2 text-center text-xs text-down">
          加载更早的{noun}失败{moreError ? `：${moreError}` : ''}
          <button type="button" onClick={onRetry} className="ml-1 text-accent hover:underline">
            重试
          </button>
        </p>
      )}

      {/* 终点：明确说"没有了"，而不是留一个看起来还会加载的空当。 */}
      {!hasMore && <p className="px-3 py-2 text-center text-xs text-ink-faint">已到最早一笔</p>}
    </>
  );
}

/**
 * What a capped table says instead of quietly losing rows.
 *
 * 现在只有**当前持仓**用得到它：持仓数受 `maxPositions` 约束，所以整表拿过来再截断是
 * 安全的。历史成交与订单记录不再截断渲染 —— 它们按游标分页，屏幕上就是"已经加载的全部"，
 * 页脚改由 `PageTail` 说"还有更多 / 已到最早一笔"。
 *
 * The count is stated because "100 of 200" is itself information — the operator
 * learns a cap is in play, rather than assuming the list ends here.
 */
function CapNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="border-t border-base-800 px-3 py-2 text-xs text-ink-faint">
      只渲染最近 {shown} 行，共 {total} 行 — 更早的记录请在交易所或导出接口查询，避免一次渲染上千行拖慢页面。
    </p>
  );
}

/**
 * 空表格只留一行。
 *
 * 不用 `ui.Empty`：它的 `py-10` 是给整页空状态用的，放进表格里会在面板中间
 * 留出半屏空白 —— 那正是这次改造要修的东西。空表要说的只有"现在没有"，
 * 以及一句"什么情况下会有"。
 */
function TableEmpty({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3.5 py-2.5">
      <span className="text-base text-ink-lo">{message}</span>
      {hint && <span className="text-xs text-ink-faint">{hint}</span>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Manual-close notice                                                        */
/* -------------------------------------------------------------------------- */


/**
 * 确认并执行手工平仓（单个或全部）。
 *
 * ## 它替换掉了什么
 *
 * 原来这里是一个 `CloseNoticeModal`，标题写着「平仓不可用」、
 * 正文第一句是「该按钮不会下任何订单」。
 *
 * **那比"按钮不响应"更糟** —— 它是一个明确告诉你"这个按钮没用"的按钮。
 *
 * ## `__all__` 是一个内部哨兵，**绝不该出现在界面上**
 *
 * 第一版我把 `'__all__'` 直接当成"目标"存进 state，于是界面上出现了
 * 「以市价平掉 __all__ 的全部仓位」和「本地没有 __ALL__ 的持仓」——
 * **内部标记漏进了给操作员看的文案**，而且后者还把服务端的错误原样透出来了。
 *
 * 现在哨兵只用于**分支判断**：文案说"全部 N 个持仓"，请求走 `closeAllPositions`。
 *
 * ## 二次确认，但不啰嗦
 *
 * 平仓是破坏性操作，要确认；但确认框只说清"平什么、会怎样"——
 * 操作员按这个按钮时通常正在亏钱，那是他们最不需要读长文的时刻。
 */
function ClosePositionModal({
  traderId,
  target,
  symbols,
  onClose,
  onDone,
}: {
  traderId: number;
  /** `null` = 关闭；`'__all__'` = 全部；其他 = 该币种。**只在内部用，不显示。** */
  target: string | null;
  /** 当前持仓的币种列表 —— 用来把"全部"说成"全部 2 个持仓"而不是一个哨兵。 */
  symbols: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    closed: string[];
    /** 「全部平仓」时顺带撤掉的待成交挂单张数（单标的平仓不用它）。 */
    cancelledPending?: number;
    /**
     * 平仓失败的标的与原因。
     *
     * ⚠️ 这个字段原来**不存在**，于是「全部平仓」里部分标的失败时，
     * 界面照样显示绿色成功横幅，操作员以为清仓完成就离开，而敞口仍在裸奔
     *（外部 issue #144，真实资金）。服务端一直在返回它 —— 是前端把它丢了。
     */
    failed?: Array<{ symbol: string; error: string }>;
    stillRunning: boolean;
  } | null>(null);

  // 每次打开都清掉上一次的结果 —— 否则会看到上一次的成交结果。
  useEffect(() => {
    if (target !== null) {
      setError(null);
      setResult(null);
    }
  }, [target]);

  if (target === null) return null;

  const isAll = target === '__all__';
  /** 给操作员看的名字。**哨兵到这里就结束了。** */
  const label = isAll ? `全部 ${symbols.length} 个持仓` : target;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isAll) {
        const response = await api.closeAllPositions(traderId);
        setResult({
          closed: response.closed,
          cancelledPending: response.cancelledPending,
          /*
           * ⚠️ **必须拷 `failed`** —— 漏掉它，界面就会在"部分标的根本没平掉"时
           * 照样报成功（外部 issue #144，真实资金）。
           */
          failed: response.failed,
          stillRunning: response.stillRunning,
        });
      } else {
        const response = await api.closePosition(traderId, target);
        setResult({ closed: [target], stillRunning: response.stillRunning });
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isAll ? '全部平仓' : '手工平仓'}
      width="max-w-md"
      footer={
        result ? (
          <Button onClick={onClose}>关闭</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button variant="danger" onClick={submit} disabled={busy}>
              {busy ? '正在平仓…' : '确认平仓'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        {result ? (
          <>
            {/*
              ⚠️ **语气与文案由 `summarizeClose` 决定，不在这里拼。**

              原来这里是一段**无条件**的绿色成功横幅：只要请求没抛异常就渲染
              "已平仓：…"。而「全部平仓」是**逐个**平的，部分标的失败会进
              `response.failed` —— 那段横幅在"3 个里只平掉 2 个"时照样说成功，
              操作员以为清仓完成就离开，**而敞口仍在裸奔**
              （外部 issue #144，真实资金；主动清仓 = 避险动作）。

              收成纯函数的好处：语气只在一处决定、且可被直接单测
              （见 `lib/closeSummary.test.ts`）。
            */}
            {(() => {
              const summary = summarizeClose(result);
              const toneClass =
                summary.tone === 'danger'
                  ? 'border-down/50 bg-down/10 text-down'
                  : summary.tone === 'success'
                    ? 'border-up/50 bg-up/10 text-up'
                    : 'border-base-700 bg-base-850/60 text-ink-mid';
              return (
                <>
                  <div
                    className={`rounded-md border px-3 py-2 text-base font-semibold ${toneClass}`}
                  >
                    {summary.headline}
                  </div>
                  {/*
                    失败明细**逐条列出**（symbol + 原因）：操作员要拿着它去手动处理，
                    所以不能只给一个计数。
                  */}
                  {summary.failed.length > 0 && (
                    <ul className="space-y-1 rounded-md border border-down/40 bg-down/5 px-3 py-2">
                      {summary.failed.map((f) => (
                        <li key={f.symbol} className="text-xs leading-relaxed text-down">
                          <span className="font-semibold">{f.symbol}</span>
                          <span className="text-ink-mid">：{f.error}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              );
            })()}
            {result.stillRunning && (
              /*
               * 机器人还在跑，它下一个周期可能重新开仓。
               * **那不是 bug、是它的工作** —— 但操作员需要知道，
               * 否则会以为自己的平仓没生效。
               */
              <p className="text-base leading-relaxed text-warn">
                机器人<strong>仍在运行</strong>，它可能在下一个决策周期重新开出仓位。
                如果不想让它再开，请先「停止」机器人。
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-base leading-relaxed text-ink-hi">
              以<strong>市价</strong>平掉 <span className="font-semibold">{label}</span>
              的全部仓位，并撤掉对应的止损与止盈单。
            </p>
            {isAll && symbols.length > 0 && (
              <p className="text-xs leading-relaxed text-ink-mid">
                将依次平掉：{symbols.join('、')}
              </p>
            )}
            <p className="text-xs leading-relaxed text-ink-faint">
              成交价以交易所实际回报为准，这里无法预知滑点。
            </p>
            {error && <ErrorNote>{error}</ErrorNote>}
          </>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Positions                                                                  */
/* -------------------------------------------------------------------------- */

function distancePercent(entry: number, level: number | null): string | null {
  if (level === null || entry === 0) return null;
  const percent = ((level - entry) / entry) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

export function PositionsTable({
  traderId,
  onCloseRequest,
  onSelectSymbol,
  collapsed = false,
}: {
  traderId: number;
  onCloseRequest: (symbol: string) => void;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
  /**
   * **收起态**（2026-10-17 · 用户要求"弹性伸缩"）。
   *
   * ## 为什么这个 prop 直到今天才有（诚实记录）
   *
   * 两档高度常量（`EXPANDED_MAX_H` = `34vh` / `COLLAPSED_MAX_H` = `max(16vh,144px)`）
   * 早就存在，也早被订单表/成交表用着（它们接的是 `historyCollapsed`）；
   * **唯独持仓表这一格写死了 `max-h-[34vh]`** —— 而持仓表恰恰是用户盯着看的那张
   * （截图里 6 条持仓把区域顶满，把上面的行情与决策流挤出去）。
   *
   * 所以缺的不是"新机制"，是**这一格没接上那两个常量**。现在接上：
   * `collapsed` 只影响**一个 class**，节点、`ref`、滚动容器全都不变。
   *
   * ⚠️ 与订单/成交表同一条纪律：**收起只换 class，绝不卸载表格** ——
   * 那张表的滚动框同时是分页观察器的 `root`（见 `COLLAPSED_MAX_H` 的注释）。
   * 持仓表不分页，但保持同一个写法，避免"同一概念两种实现"。
   */
  collapsed?: boolean;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.positions);
  const query = usePolled((signal) => api.traderPositions(traderId, signal), {
    intervalMs: 5000,
    deps: [traderId],
  });

  /*
   * ⚠️ **实时查询优先，WebSocket 镜像只作兜底** —— 这个顺序在 2026-10-04 之前是反的。
   *
   * 这里原来是 `live ?? query.data ?? []`（**镜像优先**），于是在
   * **机器人停止之后** `live` 是死的：WebSocket 不再推送，它永远停在停止那一刻。
   * 用户凌晨打开页面就看到了**幽灵持仓**：
   *
   * > 「当前持仓这两笔，我都手动点了平仓（页面显示成功）但是我刷新页面后持仓又出现，
   * >  又点击平仓后提示"本地没有 DOGEUSDT 的持仓"」
   *
   * 那两笔其实在他更早的时候（20:35）就真的平掉了 —— 交易所那边是空仓，
   * 实时查询返回的就是空。
   *
   * 而 `TraderPage` 里那份 `positions`（卡片与 tab 的计数用它）**一直是实时优先的**，
   * 于是同一页上出现了自相矛盾：**「当前持仓 0」旁边摆着两行仓位**。
   * 两处必须同一个顺序 —— 那也正是那个文件里早就写下的原则
   * （"实时查交易所，而不是 WebSocket 推送的本地镜像：后者在 socket 断开时给的是过期数据"）。
   *
   * 镜像仍然保留作兜底：服务刚重启、或页面刚打开而 HTTP 还没回来那几百毫秒里，
   * 它是唯一的数据源。但它**永远不能盖过**已经拿到的实时结果 —— **哪怕是空数组**，
   * 因为空数组正是"真的空仓"这个结论。
   */
  const positions: PositionView[] = pickPositions(query.data, live);

  /*
   * 同 `OrdersTable` 的理由：**光看 `loading` 会闪**。
   * `usePolled` 在组件重挂载时把 `loading` 从 true 重新开始，而 `updatedAt` 一旦
   * 有值就说明"这个 hook 成功拿到过数据"——用后者当"从没加载过"的判据。
   * 外面再套一层延迟：快的时候不显示转圈，避免"出现又消失"的跳变。
   */
  const showSpinner = useDelayedSpinner(query.loading && query.updatedAt === null && positions.length === 0);

  /*
   * ⚠️ **配色必须在所有 `return` 之前算**（Hooks 规则：每次渲染的调用顺序必须相同）。
   *
   * 原来它写在下面 `positions.length === 0` 那个 early return **之后** ——
   * `eslint-plugin-react-hooks` 直接报 `rules-of-hooks`。
   * 空仓时"少调一个 Hook"会让 React 的状态槽位错位，那是真正的 bug 而不只是规范问题。
   */
  const symbolTones = useSymbolTones(positions.slice(0, MAX_ROWS).map((p) => p.symbol));

  /* 同 `OrdersTable`：**没成功拿到过数据时不能断言"暂无"** —— 那是一个结论。 */
  if (query.updatedAt === null && positions.length === 0) {
    /*
     * ⚠️ **读失败时不能落进"正在加载"那条分支**（2026-10-17 · 台账 FRD-02 的补充）。
     * 没有这一条，`/positions` 返回 500 的页面会一直显示转圈（或一个空盒子），
     * 而操作员唯一能读到的信息是"还没好" —— 真相是"读不到，这不等于没有持仓"。
     */
    if (query.error !== null) {
      return (
        <ErrorNote>持仓暂时读不到（不代表没有持仓）：{query.error}</ErrorNote>
      );
    }
    if (showSpinner) return <Spinner3 label="正在加载持仓" />;
    return <div className="py-8" aria-hidden />;
  }

  if (positions.length === 0) {
    /*
     * 同上：**"读不到"与"没有"必须分开说**。否则一次 500 会被渲染成
     * 「暂无持仓。模型选择空仓 — …」，那是把故障说成模型的判断。
     */
    if (query.error !== null) {
      return (
        <ErrorNote>持仓暂时读不到（不代表没有持仓）：{query.error}</ErrorNote>
      );
    }
    return <TableEmpty message="暂无持仓。" hint="模型选择空仓 — 没有符合条件的标时不会下任何订单。" />;
  }

  const shown = positions.slice(0, MAX_ROWS);

  /*
   * ⚠️ **读不到时必须说，而且要说清"下面是几秒前的读数"**（2026-10-17 · 台账 FRD-02）。
   *
   * 这一格里的数（未实现盈亏、止损价、强平价）是**真钱读数**：它们停在上一次成功
   * 的值上时，页面看起来和"刚更新过"一模一样 —— 操作员会据此判断要不要止损。
   * 同一文件的「订单/成交」表早就把 `error` 传进了 `useTablePaging`（那是另一套纪律），
   * 这里原来连 `query.error` 都没读过，两个分支判的都是 `updatedAt === null` 与
   * `positions.length === 0`。**"查不到"与"没有"是两件事**，这一行就是那条分界。
   */
  const ageSeconds =
    query.updatedAt === null ? null : Math.max(0, Math.round((Date.now() - query.updatedAt) / 1000));

  return (
    <div>
      {query.error !== null && (
        <ErrorNote className="mb-2">
          持仓暂时读不到{ageSeconds === null ? '' : `，下面是 ${ageSeconds} 秒前的读数`}：{query.error}
        </ErrorNote>
      )}
      {/* max-h as well as the cap: 100 position rows is still taller than any
          screen, and the tab bar above must stay reachable.

          ⚠️ 两档高度走**同一对常量**（`EXPANDED_MAX_H` / `COLLAPSED_MAX_H`），
          与订单表、成交表逐字一致 —— 原来这里写死 `max-h-[34vh]`，
          于是"收起"对持仓表**从来没生效过**（用户截图里那张表正是它）。
          收起态**只换这一个 class**：节点、`ref`、观察器都不换。 */}
      <div className={`scroll-x ${collapsed ? COLLAPSED_MAX_H : EXPANDED_MAX_H} overflow-y-auto`}>
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              <th className="th">合约 / 方向</th>
              <th className="th">保证金模式</th>
              <th className="th text-right">数量</th>
              <th className="th text-right">名义</th>
              <th className="th text-right">保证金</th>
              <th className="th text-right">开仓价</th>
              <th className="th text-right">标记价</th>
              <th className="th text-right">止盈</th>
              <th className="th text-right">止损</th>
              <th className="th text-right">强平价</th>
              <th className="th text-right">未实现盈亏</th>
              <th className="th text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((position) => {
              /*
         * ⚠️ **"挂单中" ≠ "没有止损"**（2026-10-19 用户要求）。
         *
         * 用户原话：
         * > 「我刚才看到这单开单的时候提示没有止损，后面又有了好像是系统自动补上，
         * >  但是这显示是不是有问题？…显示要正常不要让我产生误会」
         *
         * 市价开仓到保护单挂好之间约有 2 秒。窗口内把"还不知道"说成"没有"，
         * 会让操作员以为仓位在裸奔 —— 那是**一个结论，而此刻并没有依据**。
         *
         * 服务端算好 `protectionPending`（开仓 <60 秒且订单表里还没有保护单），
         * 这里只负责照着显示。
         */
        const protectionPending = position.protectionPending === true;
        const missingStop =
          !protectionPending && (position.stopLoss === null || position.stopLoss === undefined);
              const stopDistance = position.stopLoss ? distancePercent(position.entryPrice, position.stopLoss) : null;
              const targetDistance = position.takeProfit ? distancePercent(position.entryPrice, position.takeProfit) : null;

              return (
                <tr key={position.id} className="row-hover align-top">
                  <td className="td">
                    <div className="flex items-center gap-2">
                  <SymbolCell symbol={position.symbol} onSelect={onSelectSymbol} tone={symbolTones.get(position.symbol)} />
                      <SideBadge side={position.side} />
                      <Badge tone="muted" title="该持仓在交易所使用的杠杆倍数。">
                        {position.leverage}x
                      </Badge>
                      {protectionPending && (
                        <Badge
                          tone="muted"
                          title="刚开仓，止损/止盈单正在发往交易所（实测约 2 秒）。这不是「没有保护」，而是还没挂完。"
                        >
                          挂单中
                        </Badge>
                      )}
                      {missingStop && (
                        <Badge tone="down" title="该持仓已开仓超过 1 分钟，交易所侧仍没有止损单。">
                          无止损
                        </Badge>
                      )}
                    </div>
                    <div className="num mt-0.5 text-xs text-ink-faint">
                      持仓 {fmtDuration((Date.now() - new Date(position.openedAt).getTime()) / 60_000)}
                    </div>
                  </td>

                  {/*
                    ⚠️ **这一列原来是「数量 / 名义 / 保证金」三行挤一格。**
                    
                    用户的原话：「不要弄成三列，每个类目**单独弄成一个项目（列）**。
                    因为页面很空旷（左右空间很多），**能拆分就拆分**方便查看，
                    而且不会导致空间不够用」。
                    
                    拆开是有道理的：三者是**三个不同的量**（数量是张数、名义是敞口、
                    保证金是真金），挤在一格里时谁都无法一眼扫读、也没法纵向对比
                    不同持仓的同项。拆成独立列后，每一列都能**沿着列往下比**。
                  */}
                  <td className="td">
                    {/*
                      保证金模式（全仓 / 逐仓）—— 与订单记录那一列同源同措辞。
                      
                      ⚠️ `PositionView.marginType` 是**实时读自交易所**的当前配置
                      （`/fapi/v2/positionRisk`），不是历史快照。持仓这里它就是
                      "此刻的模式"，所以没有订单表那种"历史行取不到"的问题；
                      读不到（机器人没跑、或该字段缺失）时显示 `—`，**不默认成全仓**。
                    */}
                    <Badge
                      tone="muted"
                      title={
                        position.marginType
                          ? `该持仓在交易所的保证金模式：${marginModeLabel(position.marginType)}。实时读自交易所。`
                          : '暂时读不到该持仓的保证金模式（机器人未运行、或交易所未返回该字段）。'
                      }
                    >
                      {position.marginType ? marginModeLabel(position.marginType) : '—'}
                    </Badge>
                  </td>

                  <td className="td num text-right">{fmtQty(position.quantity)}</td>

                  <td className="td num text-right">{fmtUsd(position.notional, 2)}</td>

                  <td
                    className="td num text-right"
                    title="该仓位占用的保证金（本金）= 名义价值 ÷ 杠杆。"
                  >
                    {fmtUsd(position.marginUsed, 2)}
                  </td>

                  <td className="td num text-right">{fmtPrice(position.entryPrice)}</td>

                  <td className="td num text-right">{fmtPrice(position.markPrice)}</td>

                  <td className="td num text-right">
                    <div className="text-base text-up">
                  {position.takeProfit
                    ? fmtPrice(position.takeProfit)
                    : protectionPending
                      ? '挂单中'
                      : '无'}
                </div>
                {targetDistance && (
                  <div className="text-xs text-ink-faint">{targetDistance}</div>
                )}
              </td>

                  <td className="td num text-right">
                    <div className={`text-base ${missingStop ? 'font-semibold' : ''} text-down`}>
                {position.stopLoss
                  ? fmtPrice(position.stopLoss)
                  : protectionPending
                    ? '挂单中'
                    : '无'}
                    </div>
                    {stopDistance && <div className="text-xs text-ink-faint">{stopDistance}</div>}
                  </td>

                  <td className={`td num text-right ${position.liquidationPrice ? 'text-warn' : 'text-ink-faint'}`}>
                    {position.liquidationPrice ? fmtPrice(position.liquidationPrice) : '—'}
                  </td>

                  <td className={`td num text-right ${pnlColor(position.unrealizedPnl)}`}>
                    {fmtUsdSigned(position.unrealizedPnl, 2)}
                    <div className="text-xs">{fmtPercent(position.unrealizedPnlPercent)}</div>
                  </td>

                  <td className="td text-right">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => onCloseRequest(position.symbol)}
                      title="查看手工平仓的说明"
                    >
                      平仓
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <CapNote shown={shown.length} total={positions.length} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Orders (open / all)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Binance order states that will never change again.
 *
 * `NEW` and `PARTIALLY_FILLED` are the only genuinely live ones; everything
 * else is history, so an "open orders" view filters on exactly that.
 *
 * `FINISHED` is the **Algo** API's word for "this conditional order is done"
 * (see `binance/types.ts`'s `BinanceAlgoStatus`), and it belongs here for a
 * concrete reason: `orders.status` stores whichever vocabulary the endpoint
 * that created the row speaks. A stop that fired reports `FINISHED`, and since
 * this set did not contain it, a settled stop stayed in 「当前委托」 claiming to
 * be 已挂单 — the same display defect as a row that was never reconciled, just
 * wearing a different code. `TRIGGERED` stays out on purpose: the market order
 * it creates still has to fill.
 *
 * 服务端 `store/repositories.ts` 的 `TERMINAL_ORDER_STATUSES` 是同一份判据的另一份
 * 实现（前端不能 import 服务端），两处要一起改。
 */
const TERMINAL_STATUSES = new Set([
  'FILLED',
  'FINISHED',
  'CANCELED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
  'EXPIRED_IN_FUTURES',
]);

/**
 * 表格里的**币种单元格**：有色、（可选的）可点击。
 *
 * ## 为什么是一个共用组件
 *
 * 四张表（持仓 / 委托 / 成交 / 订单记录）都要显示币种名，此前各写一遍 ——
 * 于是"有的能点、有的不能"这种分叉迟早发生。**同一屏上的同一个概念只能有一个实现**
 * （这条教训在本文件里已经因为订单数吃过一次）。
 *
 * ## 颜色是辅助，不是信息
 *
 * 色相由 `symbolTone` 按名称哈希得到：同一个币种**在没有冲突时**永远是同一个颜色。
 * 但它只是帮眼睛定位，**身份仍然由文字承担** —— 所以颜色不参与任何判断，也不表示涨跌。
 *
 * ⚠️ **`tone` 这个可选 prop 存在的原因（2026-10-03）**：一屏最多 8 条，而调色板只有
 * 10 个颜色 —— 纯哈希仍有约 98% 的概率撞出一对同色。所以表格用
 * `useSymbolTones()` 先算一份"同屏不重复"的映射，再把它传进来。
 */
function SymbolCell({
  symbol,
  onSelect,
  tone: toneOverride,
}: {
  symbol: string;
  onSelect?: (symbol: string) => void;
  tone?: string;
}) {
  const tone = toneOverride ?? symbolTone(symbol);
  /*
   * 没有回调时退化成纯文本：表格被用在不需要跳转的地方时（比如策略体检报告），
   * 一个点不动的按钮比一段文字更糟。
   */
  if (!onSelect) {
    return <span style={{ color: tone }}>{symbol}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(symbol)}
      title={`在行情图表里查看 ${symbol}`}
      className="-mx-1 rounded px-1 transition hover:bg-base-800"
      style={{ color: tone }}
    >
      {symbol}
    </button>
  );
}

export function isOpenOrder(order: OrderRecord): boolean {
  return !TERMINAL_STATUSES.has(order.status.toUpperCase());
}

/* -------------------------------------------------------------------------- */
/*  保证金占用（本金）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 成交行的保证金占用：**服务端字段优先，行数据兜底**。
 *
 * `TradeRecord.marginUsed` 是**可选**的（服务端算不出来时干脆不给这个字段，见
 * `domain.ts` 里那段说明），所以留一条兜底：`|数量 × 开仓价| ÷ 杠杆` ——
 * 三个输入都在这一行上。优先用服务端那一份，是为了**报价来源唯一**：成交价最终以
 * 交易所回报为准，前端再拿 `entryPrice` 自己乘一遍，等于让同一个量有两个算法 ——
 * 而"两个算法"迟早会在某一笔上分岔，那时没人说得清哪个对。
 *
 * 兜底**也不把"算不出来"伪造成一个数字**：杠杆 ≤ 0、价格 / 数量为 0 或不是有限数时
 * 回 `null` → 表格显示 `—`。判据与服务端 `marginUsedOrUndefined()` 逐条对齐 ——
 * 否则服务端说"算不出来"、前端兜底却给出一个数，`—` 的含义就被前端自己破坏了。
 */
function tradeMarginUsed(trade: TradeRecord): number | null {
  if (typeof trade.marginUsed === 'number' && Number.isFinite(trade.marginUsed)) return trade.marginUsed;
  const { quantity, entryPrice, leverage } = trade;
  if (!Number.isFinite(leverage) || leverage <= 0) return null;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(quantity)) return null;
  if (entryPrice === 0 || quantity === 0) return null;
  return Math.abs(entryPrice * quantity) / Math.max(leverage, 1);
}

/**
 * 「保证金占用」列的口径说明 —— 与 `PositionsTable` 那一列**同一条措辞**。
 * 同一屏里同一个量只能有一种说法，否则操作员会怀疑它们是不是两个东西。
 */
const MARGIN_USED_TITLE = '该仓位占用的保证金（本金）= 名义价值 ÷ 杠杆。';

/**
 * 委托那一列的主语是"委托"而不是"仓位"，所以按 `OrderRecord.marginUsed` 的口径另起一句：
 * 开仓单是这一笔自己的保证金，平仓 / 保护单取它所属持仓的。后半句说明 `—` 的含义 ——
 * 这个数由服务端给出，**没有这个数不等于这个数是 0**。
 */
const ORDER_MARGIN_USED_TITLE =
  '该委托涉及的保证金（本金）：开仓单是这一笔自己占用的，平仓 / 保护单取所属持仓占用的。— 表示服务端算不出这个数（例如被拒的单、没有对应本地持仓的单），不是 0。';

/**
 * 「保证金模式」列的口径说明 —— 用户的原话是「订单记录里面显示：全仓\逐仓」。
 *
 * 两句话分别说清"这是什么"与"两种模式的区别"，不写"保证金模式"四个字了事：
 * 全仓与逐仓的差别**是风险差别**（一个亏光整个钱包、一个只亏这一仓的保证金），
 * 而这一列的存在意义就是让操作员一眼看出这个仓位是不是在动整个账户的钱。
 */
const ORDER_MARGIN_MODE_TITLE =
  '该标的的保证金模式。全仓 = 整个合约钱包共同承担这一仓的亏损；逐仓 = 这一仓最多亏掉自己那份保证金。';

/**
 * 这一格的值是**哪来的** —— 两种口径不能共用一句话。
 *
 * `order` 是落库的历史快照（`orders.margin_type`，迁移 v14），可以当证据；
 * `position` 是**此刻**从交易所读到的账户配置，**回答不了"那张单当时是什么模式"** ——
 * 悬停说明必须把这件事说出来，否则以后有人会拿它当历史证据（这正是这个仓库
 * 在 `marginUsed` 那次学到的：同一屏上两个口径长得一样，就会被当成同一个数）。
 */
const ORDER_MARGIN_MODE_SOURCE_TITLE = {
  order: '下单当时该标的的保证金模式（下单那一刻由服务端记下，取自交易所确认过的配置）。',
  position:
    '这张单落库时没有记下保证金模式（迁移之前的历史行，或该标的的模式从未成功设置过）。这里显示的是该标的当前的账户配置 —— 实时读自交易所，不是下单那一刻的快照，不能当历史证据。',
  /* 两个来源都没有 —— 说清为什么是空的，而不是让它看起来像一个渲染错误。 */
  none: '这一行没有保证金模式的记录：它可能是迁移之前的历史行，该标的的模式也可能从未成功设置过，而且它现在没有持仓可供读取。— 表示"不知道"，不是"全仓"。',
} as const;

/**
 * 「保证金模式」那一格：`全仓` / `逐仓` / `—`。
 *
 * 抽成一个组件（而不是在行内写三元）是因为它有**三态 + 两种来源**，而行内那个位置
 * 已经被状态列的注释占满了；口径判断本身在 `orderMarginMode()` 里（纯函数、有测试）。
 *
 * ## 两种入参，对应两张表
 *
 * · **订单表**给 `order`：那里的问题"这张单当时是什么模式"存在**两种来源**
 *   （落库快照优先、当前持仓兜底），走 `orderMarginMode()`；
 * · **成交表**给 `mode`：后端已经 `LEFT JOIN orders` 把入场单的模式带出来了，
 *   只有一个来源 —— **不做兜底**。补录的回合（进程没运行时平的仓）本来就没有
 *   对应的本地订单行，用"当前配置"顶上会把"不知道"说成一个看起来很确定的值。
 */
/**
 * 订单表里的**杠杆**单元格。
 *
 * ## 为什么它只是一个"按标的查表"的组件
 *
 * **委托单没有杠杆字段** —— 杠杆是**该标的的持仓设置**（属于仓位，不属于订单）。
 * 一张还没成交的挂单，它的杠杆就是"这个标的现在设的杠杆"。所以数据只能来自
 * 页面那份当前持仓读数（`liveLeverages`），和「保证金模式」的兜底走同一条路。
 *
 * ## 取不到时显示 `—`，不补默认值
 *
 * 一个既没成交、也没有持仓的挂单确实没有这个读数（系统手上没有交易所对该标的的
 * 杠杆设置）。**补一个 1x 或 5x 都是编造** —— 与「保证金模式」列同一条约定：
 * 没读到就画 `—`，并用 `title` 说清为什么空。
 *
 * ## 措辞
 *
 * 显示成 `5x`，与持仓表的「方向 / 杠杆」列完全一致 —— 同一个概念在两处必须是
 * 同一个写法，否则操作员会以为它们在说不同的东西。
 */
/**
 * 委托表的「方向」列。
 *
 * 用户 2026-10-03 的要求：「**开仓的单子，方向改成多/空；止损/止盈的不要显示方向**」。
 *
 * | 用途 | 显示 | 为什么 |
 * | --- | --- | --- |
 * | 开仓 / 加仓 | **做多 / 做空** | "买入/卖出"是交易所的动词；他要知道的是**这个仓位是多还是空**。而 `BUY` 在平空时也会出现，动词本身有歧义 |
 * | 止损 / 止盈 | **`—`** | `closePosition` 条件单，**方向对它们没有意义** —— 印"买入"会让人以为"这是一笔要做多的单" |
 * | 平仓 | 保持**买入 / 卖出** | 那是**动作**（平掉），不是方向；平多与平空的动词不同，恰好是他需要的区分 |
 */
function OrderSideCell({ order }: { order: OrderRecord }) {
  const long = order.side === 'BUY';

  if (order.purpose === 'stop_loss' || order.purpose === 'take_profit') {
    return (
      <span
        className="text-ink-faint"
        title="止损 / 止盈是「平掉这个仓位」的条件单，方向对它们没有意义 —— 买或卖只是交易所执行平仓用的动词。"
      >
        —
      </span>
    );
  }

  if (order.purpose === 'entry' || order.purpose === 'adjustment') {
    return (
      <span
        className={long ? 'text-up' : 'text-down'}
        title={long ? '买入开仓 = 做多' : '卖出开仓 = 做空'}
      >
        {long ? '做多' : '做空'}
      </span>
    );
  }

  /* 平仓：这是"动作"而不是"方向"，保留交易所的动词。 */
  return (
    <span className={long ? 'text-up' : 'text-down'} title={long ? '买入平仓（平掉空头）' : '卖出平仓（平掉多头）'}>
      {long ? '买入' : '卖出'}
    </span>
  );
}

/**
 * 一张表的**同屏不重复配色**：按行序给每个币种分配一个还没被用过的颜色。
 *
 * 用户 2026-10-03 的原话：「**你这记录页也就最多显示 8 条，那是不是说最多找
 * 10 个颜色，循环使用就能完美解决这个问题了呢？**」——他的方向是对的，这一层
 * 就是把"循环使用"里会撞的那部分补掉。
 *
 * ## 为什么光靠哈希不行
 *
 * 调色板 10 个颜色、一屏 8 条，按生日问题**至少有一对同色的概率约 98%**。
 * 所以这里按行序做一次贪心：每个币种从哈希给的位置起，找**第一个这一屏还没用过**
 * 的颜色。10 > 8，所以一定找得到。
 *
 * ## 代价（写清楚，因为它是取舍而不是缺陷）
 *
 * 同一个币种的颜色**取决于同屏还有谁**，所以它在 A 页可能是蓝、在 B 页可能是青。
 * 这是"同屏分得清"与"翻页颜色不变"之间必须选一个，而**用户看的正是同一屏里
 * 这几行的区分度** —— 认错"这一行和那一行是不是同一个币"才是真正的误读来源。
 *
 * 表是分页/流式的，所以这里对**已经渲染出来的这一批**去重；同一批里互不相同，
 * 那就够了。
 */
function useSymbolTones(symbols: readonly string[]): Map<string, string> {
  return useMemo(() => {
    const used = new Set<string>();
    const map = new Map<string, string>();
    for (const symbol of symbols) {
      if (map.has(symbol)) continue;
      const tone = symbolToneWithAvoidance(symbol, used);
      used.add(tone);
      map.set(symbol, tone);
    }
    return map;
  }, [symbols]);
}

function LeverageCell({ order }: { order: OrderRecord }) {
  const leverage = order.leverage;
  /*
   * ⚠️ **只有开仓单显示杠杆** —— 见调用点那段注释（用户指出的"倒反天罡"）。
   *
   * 保护单（止损 / 止盈）显示 `—` 不是因为"读不到"，而是因为**那个数字不属于它**：
   * 杠杆是仓位的属性，把仓位的 3x 印在一张条件单上会让人以为"这张单是 3 倍杠杆"。
   */
  const owned = order.purpose === 'entry' || order.purpose === 'adjustment';
  if (!owned) {
    return (
      <span className="text-ink-faint" title={`${order.type || '这张单'}不显示杠杆 —— 杠杆是它所属仓位的属性，印在保护单上会被误读成"这张单是 N 倍杠杆"。`}>
        —
      </span>
    );
  }
  if (typeof leverage !== 'number' || leverage <= 0) {
    return (
      <span
        className="text-ink-faint"
        title={`没有 ${order.symbol} 的杠杆读数 —— 本地既没有该标的的持仓行，也没有它的挂单行，所以这个数确实不存在（不补默认值）。`}
      >
        —
      </span>
    );
  }
  return <span title={`${order.symbol} 的杠杆倍数 ${leverage}x（来自本地持仓/挂单行上的设置）。`}>{leverage}x</span>;
}

function MarginModeCell({
  order,
  mode,
  symbol,
  liveBySymbol,
}: {
  order?: OrderRecord;
  /** 后端已经带出来的值（成交表走这条）。可能缺失。 */
  mode?: MarginMode;
  /** 该行对应的标的 —— 用于"当前持仓"兜底（成交表也走这条）。 */
  symbol?: string;
  liveBySymbol?: ReadonlyMap<string, MarginMode> | null;
}) {
  if (order) {
    const resolved = orderMarginMode(order, liveBySymbol);
    if (resolved === null) {
      return (
        <span className="text-ink-faint" title={ORDER_MARGIN_MODE_SOURCE_TITLE.none}>
          —
        </span>
      );
    }
    return (
      <span
        title={
          resolved.source === 'order'
            ? ORDER_MARGIN_MODE_SOURCE_TITLE.order
            : ORDER_MARGIN_MODE_SOURCE_TITLE.position
        }
      >
        {marginModeLabel(resolved.mode)}
      </span>
    );
  }

  /* 后端带了值 → 那是**当时**的、可信的。 */
  if (mode !== undefined) {
    return <span title={TRADE_MARGIN_MODE_TITLE.known}>{marginModeLabel(mode)}</span>;
  }

  /*
   * 没有落库值 → 看该标的**现在**有没有持仓。
   *
   * ⚠️ 这一路和订单表共用同一套判断（`TRADE_MARGIN_MODE_TITLE.position` 明确写出
   * "这是当前配置、不是快照"），理由是**用户看到一片 `—` 会以为功能坏了** ——
   * 而这批历史行在迁移之前本来就没记过这个字段，全都取不到。
   * 兜底能让他看到"这个标的现在是逐仓"，同时措辞里说清它不能当历史证据。
   */
  const fallback = symbol ? liveBySymbol?.get(symbol) : undefined;
  if (fallback !== undefined) {
    return <span title={TRADE_MARGIN_MODE_TITLE.position}>{marginModeLabel(fallback)}</span>;
  }

  return (
    <span className="text-ink-faint" title={TRADE_MARGIN_MODE_TITLE.none}>
      —
    </span>
  );
}

/**
 * 成交表那一格的措辞。
 *
 * 三种来源必须**分别**说清，否则读者分不清哪一行可信：
 *  · `known`    —— 入场订单落库的配置，**是当时的值**；
 *  · `position` —— 落库值缺失时用该标的**当前**的配置兜底，**不是快照**；
 *  · `none`     —— 两者都拿不到，`—` 表示"不知道"，不是"全仓"。
 */
const TRADE_MARGIN_MODE_TITLE = {
  known: '该回合入场时的保证金模式，取自入场订单落库的配置 —— 这是当时的值。',
  position:
    '这张成交的入场订单没有记下保证金模式（迁移之前的历史行，或该标的的模式从未成功设置过）。' +
    '这里显示的是该标的当前的账户配置 —— 实时读自交易所，不是成交当时的快照，不能当历史证据。',
  none:
    '这一行没有保证金模式的记录：入场订单在迁移之前（没有这一列），' +
    '或者这一笔是补录的（机器人没运行时平的仓，没有对应的本地订单行），' +
    '而且该标的现在没有持仓可供读取。— 表示"不知道"，不是"全仓"。',
} as const;

export function OrdersTable({
  paging,
  onlyOpen,
  positionCount,
  paper,
  onSelectSymbol,
  collapsed = false,
  liveMarginModes,
  liveLeverages,
}: {
  /*
   * 行数据由**容器**（`TraderTables`）持有，不在这里自己拉。
   *
   * 理由不是"架构好看"，而是标签上那个「当前委托 N」与这张表必须说同一件事：
   * 它们以前各读一份数据（标签读 WebSocket 推来的 `order` 事件，表格读 REST 的第一页），
   * 于是刚打开页面时标签是 0、表格里却有十几行。行数据只有一份，就不可能再有第二个数。
   *
   * 只拉**第一页**（26 = 25 + 一条探针），每 15 秒一次。以前是 `traderOrders(id, 200)`：
   * 无论有没有人看，每 15 秒把 200 行宽订单重新拼一遍响应、重新渲染一遍 DOM。
   * 更早的行由 `useTablePaging` 在操作者滚到底时按 `before=id` 游标取回，
   * 轮询的返回值只**并进**已加载的那些行，不会把它们重置掉。
   */
  paging: TablePaging<OrderRecord>;
  onlyOpen: boolean;
  /** 本地持仓数：判断"这张看起来还挂着的单"能不能被相信，见状态列上的标注。 */
  positionCount: number;
  /**
   * **这台机器人在不在模拟盘**（`lib/glossary.ts` 的 `isPaperView`）。
   *
   * 模拟盘的订单从不出现在交易所（`broker.ts` 的 `simulateStandard`），
   * 所以"本地挂单 ↔ 交易所读数对不上"这个判据对模拟盘**必须整个关掉** ——
   * 否则每一张保护单都会被标成"读可能对不上"，那正是用户实测 `U-3` 报上来的
   * 「已挂单（待对账）」（台账 `ORD-01`）。必填：漏传应当编译不过。
   */
  paper: boolean;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
  /**
   * 收起态：**只把滚动框的 `max-height` 改小**，不动 DOM 结构。
   *
   * 为什么不卸载表格，见 `COLLAPSED_MAX_H` 那段说明 —— 这个 `ref` 同时是分页观察器的
   * `root`，卸载重挂会让哨兵失去观察者（或者反过来被误判为可见）。
   * 「当前委托」不传（它是行动面板，默认就该看得全）。
   */
  collapsed?: boolean;
  /**
   * 保证金模式的**兜底来源**：当前持仓的 `symbol → marginType`（`PositionView.marginType`）。
   *
   * 只在 `order.marginType`（落库的历史快照）缺失时才被用到，见 `orderMarginMode()`。
   * 映射由容器（`TraderTables`）建一次给两张订单表共用 —— 每行各建一次会变成 O(行数 × 持仓数)。
   */
  liveMarginModes?: ReadonlyMap<string, MarginMode> | null;
  /**
   * 杠杆的**兜底来源**：当前持仓的 `symbol → leverage`。
   *
   * ## 为什么订单的杠杆要从持仓取
   *
   * **委托单本身没有杠杆字段** —— 杠杆是**该标的的持仓设置**（属于仓位，不属于订单）。
   * 一张还没成交的挂单，它的杠杆就是"这个标的现在设的杠杆"。
   * 所以只能像保证金模式一样，按标的从当前持仓读数里取。
   *
   * ## 已知限制（数据的物理边界，不是 bug）
   *
   * 只有**当前有持仓**的标的能查到杠杆；一个既没成交、也没持仓的挂单显示 `—`。
   * 这与「保证金模式」列的限制完全一致 —— 两列会一起缺，不会出现一个有、一个没有的怪象。
   *
   * 映射同样由容器建一次、两张订单表共用。
   */
  liveLeverages?: ReadonlyMap<string, number> | null;
}) {
  const all: OrderRecord[] = paging.rows;
  const orders = onlyOpen ? all.filter(isOpenOrder) : all;
  /* 同屏不重复的配色 —— 见 `useSymbolTones()`（探针行也在 `paging.rows` 里，
     但它已经被 `isOpenOrder` 过滤掉了，不会占色）。 */
  const symbolTones = useSymbolTones(orders.map((o) => o.symbol));

  /*
   * ⚠️ **"暂无"是一个结论，结论要有依据 —— 数据还在路上时不能说。**
   *
   * 实测的真实序列（MutationObserver 逐次记录，刷新后点「当前委托」）：
   *
   *     spinner                 400ms
   *     1/LTCUSDT多|—|0.288     ← 默认标签的持仓表漏了一帧
   *     empty-orders            ← ⚠️「暂无当前委托。」——**那时数据还在路上**
   *     spinner                 又转圈
   *     4/2026-09-|LTCUSDT|止盈  ← 这才是真正的委托
   *
   * 用户看到的就是 `empty-orders` ↔ 数据的跳变，加上持仓表的闪现 —— 他形容为
   * 「错位 + 频率高，仿佛多个重叠」。
   *
   * 所以这里分三步，各自都有依据：
   *   ① 还没成功拿到过数据 → **保留加载占位**（延迟 350ms 才显示转圈；
   *      在此之前给一个撑住高度的空盒子，**没有视觉跳变**）；
   *   ② 拿过数据、当前确实没有行 → 这时才可以显示「暂无」；
   *   ③ 有行 → 显示表格。
   */
  const showSpinner = useDelayedSpinner(paging.loading && !paging.hasLoadedOnce && all.length === 0);

  if (!paging.hasLoadedOnce && all.length === 0) {
    if (showSpinner) return <Spinner3 label="正在加载委托" />;
    /*
     * 转圈还没到显示时机 —— 给一个**占位**而不是"暂无"。
     * 高度与空状态接近，避免表格区域在数据到达时发生布局跳动。
     */
    return <div className="py-8" aria-hidden />;
  }

  if (orders.length === 0) {
    return onlyOpen ? (
      <TableEmpty message="暂无当前委托。" hint="交易所侧的止损 / 止盈单在触发前会出现在这里。" />
    ) : (
      <TableEmpty message="暂无订单记录。" />
    );
  }

  return (
    <div>
      {/*
        ⚠️ **第一页读取失败必须可见**（2026-10-17 · 台账 FRD-02 的同一族）。

        `useTablePaging` 一直把首屏的 `polled.error` 传出来（`error`），而**没有任何
        一处渲染它** —— 翻页失败有 `PageTail` 说，首屏失败却静默，这是同一份纪律
        只做了一半。表格里剩下的行是上一次成功读到的，必须说清它有多旧。
      */}
      {paging.error !== null && (
        <ErrorNote className="mb-2">
          读取失败，下面是上一次成功读到的记录：{paging.error}
        </ErrorNote>
      )}
      {/*
        14 columns: this is the table that most needs its own horizontal
        scroller rather than a page-wide one.

        `max-h-[34vh] overflow-y-auto` 同时是**分页观察器的 root**（`paging.scrollerRef`）：
        行高超过 60vh 之后是**这个盒子**在滚，不是页面。观察错了对象，
        哨兵会在"没滚到底"时就被判为可见，于是一口气把整段历史拉进来。

        收起态换的是**这一个 class**（`COLLAPSED_MAX_H`），节点、`ref`、观察器都不换 ——
        理由见 `COLLAPSED_MAX_H`。
      */}
      <div
        ref={paging.scrollerRef}
        className={`scroll-x ${collapsed ? COLLAPSED_MAX_H : EXPANDED_MAX_H} overflow-y-auto`}
      >
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              {/*
                ⚠️ **「持仓时长」与「平仓时间」是两列**（2026-10-19 用户要求）。
                用户原话：「持仓时间 和 时间分开做一下区分」。

                原来它们挤在同一格：`15分 · 2026-10-19 20:25:45` ——
                一个 `·` 把两个**不同量纲**的东西连在一起：
                ```
                  15分           ← 持续了多久（相对量）
                  2026-10-19...  ← 什么时候结束（绝对时刻）
                ```
                挤在一起时既不好纵向扫读（一列里混两种格式），
                也没法排序（"哪笔持得最久"看不出来）。
              */}
              <th className="th" title="这笔仓位从开仓到平仓持续了多久。">
                持仓时长
              </th>
              <th className="th" title="这笔仓位被平掉的时间。">
                平仓时间
              </th>
              <th className="th">交易对</th>
              <th className="th">用途</th>
              <th className="th">方向</th>
              <th className="th">类型</th>
              <th className="th text-right">数量</th>
              {/* 保证金紧跟在"数量"后面：它和数量、价格是同一组的三个量，
                  隔着"触发价 / 已成交"去看会让人以为它属于后者。 */}
              <th className="th text-right" title={ORDER_MARGIN_USED_TITLE}>
                {BALANCE_LABEL.marginUsed}
              </th>
              {/*
                杠杆紧跟在「保证金占用」后面 —— 占用 ≈ 数量 × 价格 ÷ 杠杆，
                三个量是同一条式子的三项，本来就该挨着。

                用户 2026-10-03：「当前委托里面的订单要显示 杠杆」。
              */}
              <th className="th text-right" title="该标的当前的杠杆倍数（来自当前持仓读数，不是下单当时的快照）">
                杠杆
              </th>
              {/* 保证金模式紧跟在「保证金占用」后面：两者说的是同一件风险的两面
                  （压了多少本金 / 这笔本金亏光之后会不会牵连别的仓位）。
                  放在"交易对"旁边也说得通，但那里已经隔着一个用途徽章了。 */}
              <th className="th" title={ORDER_MARGIN_MODE_TITLE}>
                保证金模式
              </th>
              <th className="th text-right">价格</th>
              <th className="th text-right">触发价</th>
              <th className="th text-right">已成交</th>
              <th className="th text-right">均价</th>
              <th className="th">状态</th>
              <th className="th">错误</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              /*
               * 这张"还挂着"的单，现在能不能被相信？
               *
               * `orders.status` 是**下单那一刻**交易所给的返回值，之后由服务端的对账
               * （`AutoTrader.settleStaleOrders()`）在确认"交易所已经不挂着了"之后改写。
               * 也就是说界面上的 `NEW` 只代表"上一次对账之后它还是这个状态"。
               *
               * 判据故意取得很窄，宁可少标也不要错标：只有**整本账都没有持仓**时，
               * 一张仍然写着挂单的委托才值得怀疑（实盘上那 16 行孤儿委托，每一个标的的
               * 本地持仓都是 0）。有持仓时保护单本来就该挂在那里，标上去只会制造假警报 ——
               * 而假警报和数据缺失一样会让这个界面失去信任。
               *
               * ⚠️ **但入场单不算可疑 —— 它在成交之前，整本账本来就是空的。**
               *
               * 这正是上面那条判据唯一抓错的地方：一张**限价入场单**从挂出到成交
               * 之间必然没有持仓，那是它的**正常状态**，不是"账本可能错了"。
               * 把它标成「待对账」，等于给每一张刚挂出的单都挂上一个"数据可能不对"
               * 的警告，而这个警告会一直挂到它成交或被撤（最长 `pendingEntryTimeoutMinutes`）。
               *
               * 实测（用户连着两次问到这里）：一张 `03:23:14` 挂出的 HYPEUSDT 限价单，
               * 界面上写着「已挂单（待对账）」，他问的是"这个不是系统应该自动自主
               * 实时处理的吗"。答案是：**它本来就在正常等待，没有任何东西需要处理。**
               *
               * 真正可疑的是**保护单**：有止损/止盈挂着、而整本账没有任何持仓 ——
               * 那才是"委托与持仓对不上"。所以只对那两种用途保留这个标记。
               *
               * 入场单成交之后由谁纠正？`applyExchangeFill()`（成交推送到达即对账）
               * 与 `settleStaleOrders()`（对账兜底），两条路都在服务端 ——
               * **界面不需要用一个警告去替它们兜底**，那只会让操作员学会忽略这个颜色。
               */
              const pendingReconcile = needsReconcileFlag({
                onlyOpen,
                stillOpen: isOpenOrder(order),
                purpose: order.purpose,
                positionCount,
                paper,
              });

              /*
               * ⚠️ **成交数量已经等于下单数量时，这一单就是成交了 —— 不管 `status` 那一刻写的是什么。**
               *
               * 实测一条真实的市价开仓单：交易所返回
               * `{"status":"NEW","executedQty":"0.000","avgPrice":"0.00"}`，而**持仓那边
               * 确实出现了那个数量**。于是表格里出现了自相矛盾的一行 ——
               * 「状态」列写着**已挂单**（读 `status`），而同一行的「已成交」列写着
               * **0.009**、均价 **2634.32**（读 `filled_qty` / `avg_price`）。
               *
               * **一个自己跟自己打架的表格，比少一列更糟**：操作员会去数到底是哪个对，
               * 而正确答案是"这一单已经成交了，只是状态字段没跟上"。
               *
               * 所以这里按**事实**显示：数量对上就是已成交。容差用相对值
               * （交易所会对数量做四舍五入，不保证位级相等），与 `autoTrader`
               * 里 `fullyExecuted`、以及 `broker.ts` 里 `normalizeStandard` 的终态判据
               * **同一口径** —— 三处对"什么算成交完了"必须是同一个答案。
               *
               * 排除掉撤销/拒绝/过期：那些状态下即使数量曾经对上，结论也已经变了。
               */
              const fullyFilled =
                order.quantity > 0 &&
                order.filledQty >= order.quantity * (1 - 1e-9) &&
                !/cancel|reject|expired/i.test(order.status);

              return (
                // `data-row-id` 是**给滚动锚点用的 DOM 标记**（见 `useTablePaging` 里那个
                // `useLayoutEffect`）：新订单插到顶部时要靠它量出"我正在读的那一行"被推了多远。
                <tr key={order.id} className="row-hover" data-row-id={order.id}>
                  <td className="td num text-ink-faint">{fmtDateTime(order.createdAt)}</td>
                    <td className="td font-semibold"><SymbolCell symbol={order.symbol} onSelect={onSelectSymbol} tone={symbolTones.get(order.symbol)} /></td>
                  <td className="td">
                    <Badge tone={purposeTone(order.purpose)}>{orderPurposeLabel(order.purpose)}</Badge>
                  </td>
                  {/*
                    方向列：**只有"动仓位方向"的单子才显示方向，而且说人话。**

                    用户 2026-10-03 的要求：「**开仓的单子，方向改成多/空；
                    止损/止盈的不要显示方向**」—— 两条都对：

                      · 开仓单写"买入/卖出"是**交易所的动词**，不是交易员的语言。
                        "卖出"在开仓语境里就是**做空**、"买入"就是**做多** ——
                        他看这一列想知道的是"这个仓位是多还是空"。
                        （顺带：`BUY` 也可能是平空，动词本身还歧义。）
                      · 止损 / 止盈单是 `closePosition` 条件单，**方向对它们没有意义** ——
                        显示"买入"只会让人以为"这是一笔要做多的单"。

                    平仓单（`exit`）保持"买入/卖出"：那是**动作**（平掉），不是方向，
                    而平多与平空的动词不同，恰好是他需要的区分。
                  */}
                  <td className="td font-semibold">
                    <OrderSideCell order={order} />
                  </td>
                  <td className="td text-ink-lo">{orderTypeLabel(order.type)}</td>
                  <td className="td num text-right">{fmtQty(order.quantity)}</td>
                  {/* `OrderRecord.marginUsed` 是**可选**字段：服务端算不出这一行对应的保证金时
                      就不给（被拒的单、没有对应本地持仓的单…）。所以这一格必须显示 `—`
                      而不是 `0` —— `fmtUsd(undefined)` 是 `—`、`fmtUsd(0)` 是 `$0.00`，
                      这两件事在任何时候都不能混。 */}
                  <td className="td num text-right">{fmtUsd(order.marginUsed, 2)}</td>
                  {/*
                    ⚠️ 杠杆紧跟在「保证金占用」后面 —— 那三个量（数量 / 占用 / 杠杆）是同一条式子的三项
                    （占用 ≈ 数量 × 价格 ÷ 杠杆），隔着别的列去看会让人以为它属于后者。

                    用户 2026-10-03 的要求：「当前委托里面的订单要显示 杠杆」。

                    ⚠️ **两天后他指出了这里的"倒反天罡"**，而他说得对：

                      · 这一格原来按**标的的当前持仓**读音杠杆，而那份列表来自**交易所
                        的真实持仓** —— 挂单还没成交、交易所没有持仓，于是**开仓单
                        永远显示 `—`**（该显示的显示不出来）；
                      · 而保护单（止损/止盈）恰好属于一个已存在的仓位，反而"读得到"，
                        显示出 `3x`（不该显示的显示了）。

                    **杠杆是仓位的属性，不是那张条件单的属性** —— 在保护单那一行显示
                    `3x`，会让人以为"这张止损单是 3 倍杠杆"。所以：

                      · 读数改由**订单自己带上**（`order.leverage`，服务端从本地
                        `positions` 取，**含 `pending` 行** —— 挂单在本地是有持仓行的）；
                      · **只有开仓单显示**，其余一律 `—`。
                  */}
                  <td className="td num text-right">
                    <LeverageCell order={order} />
                  </td>
                  {/*
                    保证金模式：落库值优先，当前持仓兜底（见 `orderMarginMode()`）。

                    ⚠️ **`—` 不是「全仓」。** 币安的默认确实是全仓，但"默认是"与
                    "我们读到了"是两件事 —— 把没读到的行渲染成「全仓」等于替交易所
                    宣布一个我们没验证过的事实。所以两个来源都拿不到时只画 `—`，
                    并用 `title` 说明为什么空。
                  */}
                  <td className="td">
                    <MarginModeCell order={order} liveBySymbol={liveMarginModes} />
                  </td>
                  <td className="td num text-right">{order.price ? fmtPrice(order.price) : '市价'}</td>
                  <td className="td num text-right text-ink-lo">{order.stopPrice ? fmtPrice(order.stopPrice) : '—'}</td>
                  <td className="td num text-right">{fmtQty(order.filledQty)}</td>
                  <td className="td num text-right">{order.avgPrice ? fmtPrice(order.avgPrice) : '—'}</td>
                  <td className="td">
                    {/*
                      `order.status` 是币安自己的机器码（NEW / FILLED / …），
                      中文标签在 `@aq/shared` 的 ORDER_STATUS_LABELS —— 之前这里
                      直接把英文码打在表格里。

                      ⚠️⚠️ **这一格只说委托自己的事实，不再写「（待对账）」**
                      （2026-10-17 · 台账 ORD-01 / 用户实测 U-3）。用户原话：
                      「（待对账）这个是设计之初就明确说过**不需要也不能出现**的」。

                      `pendingReconcile` 表达的那个安全关切**没有丢**，但它换了位置：
                      ① 颜色仍然是 `text-warn`；② `title` 说清"交易所上一次说的是什么、
                      为什么值得注意、谁去弄明白"；③ 服务端日志与审计面板里本来就有
                      这件事（`settleStaleOrders` 走的路径）。

                      把内部处理过程摆成一个**订单状态词**，等于给每一行挂上
                      "账实不符"的告警 —— 那是虚假的对账告警，而假警报会让操作员
                      学会忽略这一列的颜色（本文件反复写过同一条教训）。
                    */}
                    <span
                      title={
                        pendingReconcile
                          ? reconcileNoteTitle(order.status)
                          : fullyFilled
                            ? `成交数量 ${fmtQty(order.filledQty)} 已等于下单数量 ${fmtQty(order.quantity)}，所以这一单实质已成交 —— 尽管交易所那一刻返回的状态是 ${order.status}。`
                            : order.status
                      }
                      className={
                        pendingReconcile
                          ? 'text-warn'
                          : isOpenOrder(order)
                            ? 'text-up'
                            : /cancel|reject|expired/i.test(order.status)
                              ? 'text-warn'
                              : 'text-ink-mid'
                      }
                    >
                      {fullyFilled ? '已成交' : orderStatusLabel(order.status)}
                    </span>
                  </td>
                  <td className="td max-w-[240px] truncate text-down" title={order.error ?? undefined}>
                      {order.error ? exchangeErrorLabel(order.error) : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {/* 末尾状态（哨兵 / 加载中 / 失败可重试 / 已到最早一笔）必须在滚动框**里面**：
            哨兵要和滚动框这个 root 比较，放到框外面等于永远不交叉。 */}
        <PageTail
          sentinelRef={paging.sentinelRef}
          hasMore={paging.hasMore}
          moreState={paging.moreState}
          moreError={paging.moreError}
          onRetry={paging.retry}
          noun="订单"
        />
      </div>
    </div>
  );
}

function purposeTone(purpose: string): 'accent' | 'neutral' | 'down' | 'up' | 'warn' {
  switch (purpose) {
    case 'entry':
      return 'accent';
    case 'stop_loss':
      return 'down';
    case 'take_profit':
      return 'up';
    case 'adjustment':
      return 'warn';
    default:
      return 'neutral';
  }
}

/* -------------------------------------------------------------------------- */
/*  Trades                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 「对账补录」这个来源**不在表格里显示**，只在悬停该行时给出说明。
 *
 * ## 为什么把徽章去掉了
 *
 * 这里原来给补录的行挂一个橙色徽章、外加整行 `bg-warn/5` 的黄色底。理由是
 * 「看见徽章说明实时记账漏了一笔，那是操作员该知道的」—— **那个假设是错的**：
 *
 *  · 那笔成交是**真实的**（交易所的成交历史里有它），盈亏也**算得对**；
 *  · 「补录」只说明**系统是怎么知道它的**（进程当时没在跑，事后从成交历史核对出来），
 *    不说明账本有问题、更不需要操作员做任何事；
 *  · 而**当初真正值得报警的那个 bug 已经修了** —— 运行中触发的止损曾被记成
 *    `reconciled`（对账两遍的顺序反了），现在运行期的原因优先。今天还落在这个
 *    来源里的，只剩"机器人停着的时候交易所侧止盈/止损被触发"这一种正常情形。
 *
 * 所以它是一个**开发信号**，不是操作信号：开发要看"补录率"来判断记账有没有漏，
 * 而操作员看到一行黄色的 `对账补录` 只会以为出了故障。**把维护者的仪表装到
 * 操作员的界面上，代价是让正常状态看起来像异常** —— 而一个经常误报的界面，
 * 在真的出事时也没人看。
 *
 * 保留 `title`：需要的时候（比如排查）把鼠标放上去仍然能看到来源。
 */
const RECONCILED_TITLE =
  '这笔在机器人未运行期间平仓（例如交易所侧的止盈被触发），成交与盈亏取自交易所的成交历史，是真实记录。';

export function TradesTable({
  traderId,
  refreshToken,
  onSelectSymbol,
  collapsed = false,
  paging: providedPaging,
  liveMarginModes,
}: {
  traderId: number;
  refreshToken?: number;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
  /** 收起态：只把滚动框的 `max-height` 改小 —— 理由见 `COLLAPSED_MAX_H`。 */
  collapsed?: boolean;
  /**
   * 由**容器**预取好的分页实例。不传时组件内部自己建一套（向后兼容）。
   *
   * ⚠️ **为什么需要它：数据要是切过去才开始拉，就一定会闪。**
   *
   * 实测（headed 真实窗口，切到「历史成交」）：
   *
   *     23381ms  空白            ← 组件刚挂载
   *     23732ms  转圈            ← ⚠️ 这时才在请求数据
   *     24067ms  trades 25行
   *
   * 而「当前委托」不闪，因为它的数据在**容器**里、页面加载时就已经拿到了。
   * 两者差的就是"什么时候开始请求"。
   */
  paging?: TablePaging<TradeRecord>;
  /**
   * 「保证金模式」的**兜底来源**：当前持仓的 `symbol → marginType`。
   *
   * 迁移 v14 之前的成交没有这一列，届时用该标的**现在**的配置顶一下（措辞里
   * 写明"不是快照"）—— 否则整张历史表会是一片 `—`，用户会以为功能没生效。
   * 与订单表共用容器里建好的那一份映射，不各自建。
   */
  liveMarginModes?: ReadonlyMap<string, MarginMode> | null;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.trades);
  /*
   * 只拉**第一页**（26 = 25 + 一条探针），每 15 秒一次 —— 以前是 `traderTrades(id, 200)`。
   * 成交行是最宽的一张（毛/净盈亏、两侧手续费、资金费、两个订单号），
   * 更早的行由 `useTablePaging` 在滚到底时按 `before=id` 游标取回。
   */
  const query = usePolled((signal) => api.traderTrades(traderId, { limit: PAGE_LIMIT, signal }), {
    intervalMs: 15_000,
    deps: [traderId, refreshToken],
  });

  const internalPaging = useTablePaging<TradeRecord>(
    traderId,
    api.traderTrades,
    query,
    live,
    /*
     * ⚠️ **成交表必须按 `closedAt` 排，不能按 id。**
     *
     * 用户的原话：「历史成交里面日期显示错乱（不是完全按时间排序）」。
     * `trades.id` 是插入顺序，而**对账补录的行 id 更大、成交时刻更早** ——
     * 实测 18 行里 4 处乱序，界面上就是日期跳来跳去。
     *
     * 订单表不传这个参数：它的 id 顺序与创建顺序一致，按 id 排本来就是对的。
     */
    (row) => row.closedAt,
  );

  /* 容器给了就用容器的（数据早就到手，不会闪）；没给才用内部那份。 */
  const paging = providedPaging ?? internalPaging;

  // 屏幕上要渲染的全部行 = 轮询的第一页 + 已经翻出来的更早的页 + 推送进来的实时行（按 id 去重）。
  const trades: TradeRecord[] = paging.rows;
  /* 同屏不重复的配色 —— 见 `useSymbolTones()`。 */
  const symbolTones = useSymbolTones(trades.map((t) => t.symbol));

  /* 同 `OrdersTable`：只有"从没成功加载过"才显示转圈；再延迟一层，避免出现又消失。 */
  const showSpinner = useDelayedSpinner(query.loading && query.updatedAt === null && trades.length === 0);

  /* 同 `OrdersTable`：数据还在路上时不能下"暂无"的结论。 */
  if (query.updatedAt === null && trades.length === 0) {
    if (showSpinner) return <Spinner3 label="正在加载成交记录" />;
    return <div className="py-8" aria-hidden />;
  }

  if (trades.length === 0) {
    return <TableEmpty message="暂无历史成交。" hint="每笔平仓都会连同平仓原因一起持久化。" />;
  }

  /*
   * Counted on 净盈亏, not on the gross.
   *
   * Commission can turn a nominally positive round-trip into a loss (the live
   * account has one: gross +0.0011, net −0.0187), and the backend's own
   * `wins`/`losses` count the net. Counting the gross here made this header
   * disagree with the 胜率 card above it.
   *
   * 合计覆盖的是**已经加载出来的那些行**（分页之后"已加载"就是屏幕上这一份）。
   * 滚到底会自动把更早的页并进来，于是这里的数字跟着变大；翻到「已到最早一笔」时
   * 它才等于全部历史。所以 `hasMore` 为真时标题里写的是「已加载 N 笔」而不是
   * 「N 笔成交」—— 一个只统计了最近 25 笔的"净额"必须自己说清楚它的口径。
   */
  const wins = trades.filter((trade) => trade.netPnl > 0).length;
  const totals: PnlCosts = trades.reduce<PnlCosts>(
    (sum, trade) => ({
      gross: sum.gross + trade.pnl,
      fees: sum.fees + trade.fee,
      funding: sum.funding - trade.fundingFee,
      net: sum.net + trade.netPnl,
    }),
    { gross: 0, fees: 0, funding: 0, net: 0 },
  );

  return (
    <div>
      {/* 首屏读取失败与订单表同一条纪律：不说的话，下面的行看起来像刚更新的。 */}
      {paging.error !== null && (
        <ErrorNote className="mb-2">
          读取失败，下面是上一次成功读到的记录：{paging.error}
        </ErrorNote>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-base-800 px-3 py-2 text-xs">
        <span className="text-ink-lo">
          {paging.hasMore ? `已加载 ${trades.length} 笔` : `${trades.length} 笔成交`} ·{' '}
          <span className="text-up">{wins} 盈</span> /{' '}
          <span className="text-down">{trades.length - wins} 亏</span>
        </span>
        {/*
          The gross → net bridge, and it stays inline. Collapsing it into the
          single 净额 figure is the difference between a number the operator
          trusts and one they have to take on faith.
        */}
        <PnlBreakdown costs={totals} />
        <span className={`num ml-auto text-base font-semibold ${pnlColor(totals.net)}`} title={NET_PNL_FORMULA}>
          净额 {fmtUsdSigned(totals.net, 2)}
        </span>
      </div>
      {/* 与订单表同一个滚动框：它既是横向滚动盒，也是分页观察器的 root（见 `useTablePaging`）。
          收起态只换这一个 class（`COLLAPSED_MAX_H`），节点与 `ref` 都不换。 */}
      <div
        ref={paging.scrollerRef}
        className={`scroll-x ${collapsed ? COLLAPSED_MAX_H : EXPANDED_MAX_H} overflow-y-auto`}
      >
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              {/*
                ⚠️ **时间列必须在最左**（2026-10-18 · 用户实测）。
                用户的观察：「历史成交，列表中的时间显示改到最左边，和当前委托、订单记录保持一样」。
                三张表说的是同一批东西，**同一列在三个标签页里的位置必须一致**，
                否则切换标签时眼睛要重新找一遍 —— 这是可读性，不是洁癖。
              */}
              {/*
                ⚠️ **「持仓时长」与「平仓时间」是两列**（2026-10-19 用户要求）。
                用户原话：「持仓时间 和 时间分开做一下区分」。

                原来它们挤在同一格：`15分 · 2026-10-19 20:25:45` ——
                一个 `·` 把两个**不同量纲**的东西连在一起：
                ```
                  15分           ← 持续了多久（相对量）
                  2026-10-19...  ← 什么时候结束（绝对时刻）
                ```
                挤在一起时既不好纵向扫读（一列里混两种格式），
                也没法排序（"哪笔持得最久"看不出来）。
              */}
              <th className="th" title="这笔仓位从开仓到平仓持续了多久。">
                持仓时长
              </th>
              <th className="th" title="这笔仓位被平掉的时间。">
                平仓时间
              </th>
              <th className="th">交易对</th>
              {/* 方向与杠杆合成一列（`空 5x`）——杠杆只在方向旁边有意义，拆开白占宽度。 */}
              <th className="th">方向 / 杠杆</th>
              <th className="th text-right">数量</th>
              {/* 保证金紧跟在"数量"后面：数量 × 开仓价 ÷ 杠杆 就是它，三个量本来就该挨着。 */}
              <th className="th text-right" title={MARGIN_USED_TITLE}>
                {BALANCE_LABEL.marginUsed}
              </th>
              {/*
                保证金模式紧跟在「保证金占用」后面 —— 与订单表同一处摆放、同一套措辞
                （用户的原话是「历史成交里面也要显示保证金模式（全仓\逐仓）」）。
                两者说的是同一件风险的两面：占了多少本金、以及这笔本金是全仓共担还是逐仓独担。
              */}
              <th className="th" title={TRADE_MARGIN_MODE_TITLE.known}>
                保证金模式
              </th>
              <th className="th text-right">开仓价</th>
              <th className="th text-right">平仓价</th>
              <th className="th text-right">盈亏（毛）</th>
              <th className="th text-right">手续费</th>
              {/* 净盈亏与百分比合成一列 —— 它们永远一起看。 */}
              <th className="th text-right">净盈亏 / %</th>
              <th className="th">平仓原因</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => {
              const costs = tradeCosts(trade);
              const reconciled = trade.source === 'reconciled' || trade.closeReason === 'reconciled';
              /*
               * 这一笔占用的保证金。成交行**能自己算**（服务端字段缺失时用行数据兜底），
               * 因为 `quantity` / `entryPrice` / `leverage` 都在这行上；服务端有值时优先用它
               * —— 见 `tradeMarginUsed`。
               */
              const marginUsed = tradeMarginUsed(trade);
              return (
                // `data-row-id` 给滚动锚点用（见 `useTablePaging` 的 `useLayoutEffect`）。
                <tr
                  key={trade.id}
                  /* 补录来源不再改变整行底色 —— 见 `RECONCILED_TITLE` 的说明。 */
                  className="row-hover"
                  data-row-id={trade.id}
                >
                  {/*
                    ★ 时间列在第一（与「当前委托」「订单记录」两个标签页一致）。
                    原先它合并在最后一列（`持仓 / 平仓时间`），但用户实测后要求统一到最左：
                    「历史成交，列表中的时间显示改到最左边，和当前委托、订单记录保持一样」。
                    持仓时长仍然保留在这格（`3 时 42 分 · 10-18 04:14:04`），信息没丢。
                  */}
                  <td className="td whitespace-nowrap num text-ink-mid">
                    {fmtDuration(trade.holdMinutes)}
                  </td>
                  <td className="td whitespace-nowrap text-ink-faint">
                    {fmtDateTime(trade.closedAt)}
                  </td>
                  <td className="td font-semibold text-ink-hi">
                    <div className="flex items-center gap-1.5">
                      <SymbolCell symbol={trade.symbol} onSelect={onSelectSymbol} tone={symbolTones.get(trade.symbol)} />
                    </div>
                  </td>
                  <td className="td whitespace-nowrap">
                    <SideBadge side={trade.side} />
                    <span className="num ml-1 text-ink-faint">{trade.leverage}x</span>
                  </td>
                  <td className="td num text-right">{fmtQty(trade.quantity)}</td>
                  <td className="td num text-right">{fmtUsd(marginUsed, 2)}</td>
                  <td className="td">
                    {/*
                      保证金模式。数据来自后端 `LEFT JOIN orders`（入场订单那一行的
                      `margin_type`）—— 取不到就是 `—`，**不默认成"全仓"**。

                      这里**不做"当前持仓兜底"**：那是订单表才需要的东西。
                      订单表要回答"这张单当时是什么模式"，而历史行的落库值可能缺失，
                      所以用该标的**现在**的配置补一句、并在悬停说明里写明它不是快照。
                      成交表这一格问的是"这一回合当时是什么模式"—— 补录的回合（进程
                      没运行时平的仓）本来就没有对应的本地订单行，用当前配置顶上会把
                      "不知道"说成一个看起来很确定的值。
                    */}
                    <MarginModeCell mode={trade.marginType} symbol={trade.symbol} liveBySymbol={liveMarginModes} />
                  </td>
                  <td className="td num text-right">{fmtPrice(trade.entryPrice)}</td>
                  <td className="td num text-right">{fmtPrice(trade.exitPrice)}</td>
                  {/* The gross stays visible but muted: it is the input to the
                      arithmetic, not the answer. 净盈亏 is the answer. */}
                  <td className="td num text-right text-ink-lo" title={pnlFormulaText(costs)}>
                    {fmtUsdSigned(trade.pnl, 2)}
                  </td>
                  <td className="td num text-right text-warn" title={pnlFormulaText(costs)}>
                    {fmtSigned(-trade.fee, 4)}
                    <div className="text-xs text-ink-faint">
                      {/*
                        ⚠️ **这一格只能有一种符号约定，否则操作员会怀疑账本本身。**

                        此前主行取负（`-trade.fee` → 显示 `-0.0240`），而子行直接用原值
                        （`entryFee` / `exitFee` 在库里是**正数存储**的）→ 显示成
                        `+0.0118 · +0.0122`。同一个格子里**主行负数、子行正数**，
                        看起来像"手续费对不上账"（外部 issue #122）。

                        现在两个子行也取负，于是这一个格子统一成「**成本为负**」：
                        它们彼此可加，且**相加正好等于上面那一行**：

                            -0.0118 + -0.0122 = -0.0240   ← 与主行一致

                        为什么选"成本为负"而不是反过来：主行那个数是最显眼的，
                        而它显示的是"从余额里扣掉多少"；下面资金费那一行用的交易所口径
                        也是"负数表示支付"。三个数统一到同一个方向上，
                        这一格才读得出"毛 − 费 − 资 = 净"这条等式。

                        ⚠️ 注意与 `PnlCosts`（`PnlBreakdown.tsx`）的区别：那边约定
                        **成本为正**，用于展示"净 = 毛 − 成本"的减法等式；两者是不同
                        的呈现，不要互相套用。改动这一格时**不要碰** `trades.insert()`
                        里的任何算术 —— 落库口径本来是对的。
                      */}
                      开 {fmtSigned(-trade.entryFee, 4)} · 平 {fmtSigned(-trade.exitFee, 4)}
                    </div>
                    {trade.fundingFee !== 0 && (
                      <div className={`text-xs ${pnlColor(trade.fundingFee)}`} title="资金费：负数表示支付">
                        资 {fmtSigned(trade.fundingFee, 4)}
                      </div>
                    )}
                  </td>
                  <td
                    className={`td num text-right whitespace-nowrap font-semibold ${pnlColor(trade.netPnl)}`}
                    title={pnlFormulaText(costs)}
                  >
                    {fmtUsdSigned(trade.netPnl, 2)}
                    <span className="font-normal opacity-70"> · {fmtPercent(trade.pnlPercent)}</span>
                  </td>
                  <td className="td" title={reconciled ? RECONCILED_TITLE : undefined}>
                    {/* `closeReason` is a persisted machine code; the Chinese
                        label lives in CLOSE_REASON_LABELS only.

                        ⚠️ 这一格**不再因为来源是补录而变黄**：那是一个开发信号
                        （说明记账当时漏了一笔），不是操作信号 —— 这笔成交真实、
                        盈亏正确、也不需要操作员做任何事。见 `RECONCILED_TITLE`。 */}
                    <span className="text-ink-lo">
                      {closeReasonLabel(trade.closeReason, trade.netPnl)}
                    </span>
                  </td>
                  {/* 时间列已挪到最左（见 tbody 第一格）—— 这里不再重复。 */}
                </tr>
              );
            })}
          </tbody>
        </table>
        {/* 末尾状态（哨兵 / 加载中 / 失败可重试 / 已到最早一笔）必须在滚动框**里面**。 */}
        <PageTail
          sentinelRef={paging.sentinelRef}
          hasMore={paging.hasMore}
          moreState={paging.moreState}
          moreError={paging.moreError}
          onRetry={paging.retry}
          noun="成交"
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Container with the toolbar                                                 */
/* -------------------------------------------------------------------------- */

export type TraderTabId = 'positions' | 'orders' | 'trades' | 'history';

/* -------------------------------------------------------------------------- */
/*  历史区高度（收起 / 展开）                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 展开态与收起态的滚动框高度。
 *
 * ## 为什么是 `max-height`，而不是把表格卸载掉（`Collapsible` / `display:none`）
 *
 * 这两张表的滚动框（`paging.scrollerRef`）**同时是分页观察器的 `root`**：
 * 哨兵与它比较，判断"滚到底了没有"。收起时把表格卸载掉的代价是**两次**真实故障：
 *
 *  1. 展开回来时 `sentinelRef` 指向的是一个**新**节点，而观察器 effect 的依赖
 *     （`hasMore` / `moreState` / `traderId` / `listMounted`）一个都没变 → effect 不重跑
 *     → 新哨兵**没有观察者**，"滚到底加载更早的记录"静默失效（下面的 `remountKey`
 *     就是为了这个坑的另一半：节点被换掉时必须让观察器重挂）；
 *  2. `ref` 落在已卸载的节点上时，哨兵会被判成可见 → **一次把整段历史拉进来**，
 *     也就是这次分页改造要修的那个 bug。
 *
 * 所以收起**只改这一个 class**：同一个 DOM 节点、同一个 `ref`、同一个 `root`，
 * React 只更新 `class`，不重挂。
 *
 * ## 而且缩小是**安全**的方向
 *
 * 观察器的 `rootMargin` 是往下 240px。盒子变矮之后，哨兵离 `root` 底边只会**更远**
 * （`contentBottom − scrollTop − clientHeight` 随 `clientHeight` 减小而增大），
 * 所以"收起"在结构上**不可能**多取一页；反过来"展开"才会让哨兵更近一步 ——
 * 那也只是把盒子填满（本来就有的行为）。
 */
const EXPANDED_MAX_H = 'max-h-[34vh]';

/**
 * 收起态：表头 + **至少 2 行**。
 *
 * ## 为什么是 `max(16vh, 144px)` 而不是纯 `16vh`
 *
 * 纯 `16vh` 在 900px 屏上是 144px（表头约 33px ⇒ 够 3 行），**但在 150% 缩放下
 * 等效视口只有 600px ⇒ 16vh = 96px ⇒ 减掉表头只剩 1 行**。
 *
 * 而"收起"的用途是「**认得出这是哪张表、最近两笔是什么**」——
 * **只剩一行时它就退化成"只看到最新一条"，与用户要的"收缩成 2 栏"不符。**
 *
 * `max()` 让它在小视口上**不再按比例缩小**，而是保底 144px；
 * 大视口上仍然是 16vh（跟着屏幕变，不钉死）。
 *
 * ## 不变量（别为了让它更矮而改掉）
 *
 * **一行都不隐藏**：行仍然全在框里，往下滚就能看到（哨兵照旧工作）。
 * 收缩只改 `max-height`，节点、`ref`、分页观察器都不换 —— 见 `EXPANDED_MAX_H` 的说明。
 */
const COLLAPSED_MAX_H = 'max-h-[max(16vh,144px)]';

export function TraderTables({
  traderId,
  tab,
  onChange,
  positionCount,
  paper,
  refreshToken,
  onSelectSymbol,
  positionSymbols,
  onPositionsChanged,
  positions,
}: {
  traderId: number;
  tab: TraderTabId;
  onChange: (tab: TraderTabId) => void;
  positionCount: number;
  /**
   * **这台机器人在不在模拟盘** —— 见 `OrdersTable` 的同名 prop。
   *
   * 由页面按 `isPaperView()` 算好传下来（三个事实源的取值顺序在那条函数里，
   * 不允许在这里再推一遍 —— 那正是"两处必须一致、没人检查"的形态）。
   */
  paper: boolean;
  /**
   * Bumped by the caller after a manual 对账, so the tables refetch instead of
   * waiting out their 15-second poll — the numbers the operator just changed
   * should be the numbers on screen.
   */
  refreshToken?: number;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
  /** 当前持仓的币种 —— 弹窗用它把"全部"说成"全部 2 个持仓"。 */
  positionSymbols: string[];
  /** 平仓成功后通知页面立刻重取持仓 —— 否则界面还留着刚平掉的那一行。 */
  onPositionsChanged?: () => void;
  /**
   * 页面手上那份**当前持仓** —— 给订单行的「保证金模式」与「杠杆」兜底。
   *
   * ## 为什么是持仓数组而不是一个现成的 Map
   *
   * 页面已经有一份 `positions`（`/account` 的实时读数，30 秒轮询），直接把它原样传下来
   * 最简单：调用处一行、不需要在渲染里 `new Map(...)`。映射在这里用 `useMemo` 建一次，
   * 两张订单表共用。**请传稳定的数组引用**（同一份 state，不要在调用处 `.map()` 出新数组），
   * 否则 `useMemo` 每次渲染都会重建。
   *
   * ## 为什么它只是"兜底"
   *
   * 这些值的口径是**当前账户配置**（实时读交易所），不是下单当时的快照 ——
   * 历史问题由 `OrderRecord.marginType`（落库值）回答。两个来源的先后与措辞
   * 都在 `orderMarginMode()` / `ORDER_MARGIN_MODE_SOURCE_TITLE` 里定死了。
   *
   * 不传 = 没有兜底（历史行显示 `—`），表格照常工作。
   *
   * ## 2026-10-03：它同时供「杠杆」列
   *
   * 用户的原话：「当前委托里面的订单要显示 杠杆」。
   *
   * **委托单（未成交）本身没有杠杆字段** —— 杠杆是**该标的的持仓设置**，
   * 挂在持仓上、不属于某一张单。所以订单表要显示杠杆，只能像「保证金模式」
   * 一样从这份持仓读数里按标的取。同一个数组供两列，避免调用方传两份。
   *
   * 于是这个 prop 从 `positionMarginModes` 改名成 `positions` —— 它本来就是
   * 整个持仓数组，旧名字只说了它当初服务的唯一用途。
   */
  positions?: ReadonlyArray<{ symbol: string; marginType?: MarginMode | null; leverage?: number | null }>;
}) {
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [ordersRefreshToken, setOrdersRefreshToken] = useState(0);

  /**
   * `positionMarginModes` → `symbol → marginType`，供两张订单表给「保证金模式」兜底。
   *
   * 认不出的值（`undefined`、或交易所将来给出的新写法）**不进这张表** ——
   * 进不去就是"没有这个事实"，那张单显示 `—`。这里不补默认值。
   */
  const liveMarginModes = useMemo(() => {
    const map = new Map<string, MarginMode>();
    for (const position of positions ?? []) {
      if (position.marginType === 'cross' || position.marginType === 'isolated') {
        map.set(position.symbol, position.marginType);
      }
    }
    return map;
  }, [positions]);

  /**
   * `positions` → `symbol → 杠杆`，供「当前委托」与「订单记录」显示杠杆。
   *
   * ## 为什么订单的杠杆要从持仓取
   *
   * **委托单本身没有杠杆字段** —— 杠杆是**该标的的持仓设置**，属于仓位而非订单。
   * 一张还没成交的挂单，它的杠杆就是"这个标的现在设的杠杆"。
   *
   * 认不出的值（`undefined`、`null`、非正数）**不进这张表** ——
   * 没有这个事实就让单元格显示 `—`，**不补默认值**（补个 1x 或 5x 都是编造）。
   *
   * ## 已知限制（不是 bug，是数据的物理边界）
   *
   * 只有**当前有持仓**的标的能查到杠杆。一个还没成交、也没有持仓的挂单会显示 `—` ——
   * 因为系统手上确实没有"该标的的杠杆"这个读数。这与「保证金模式」列的限制一致，
   * 所以两列会一起缺，不会出现一个有一个没有的怪象。
   */
  const liveLeverages = useMemo(() => {
    const map = new Map<string, number>();
    for (const position of positions ?? []) {
      if (typeof position.leverage === 'number' && position.leverage > 0) {
        map.set(position.symbol, position.leverage);
      }
    }
    return map;
  }, [positions]);
  // One token drives both tables: the toolbar ⟳ and the caller's 对账 both mean
  // "these rows are stale".
  const token = (refreshToken ?? 0) + ordersRefreshToken;

  /**
   * 这两张表就是用户抱怨的那两个栏目：行数**没有天然上界**（每下一单、每平一仓就多一行），
   * 点开就占掉半个屏幕。所以只有它们有收起态。
   *
   * 「当前委托」刻意**不**给这个开关：它是**行动面板**（对着它撤单、确认保护单），
   * 行数受挂单数约束，默认就该看得全；给每个标签都塞一个高度开关只会让人多想一步。
   */
  const isHeavyTab = tab === 'trades' || tab === 'history';

  /**
   * 历史区是不是收起了。**一个开关同时管两张表**：它们是同一个问题的两面，
   * 操作者点一次「收起」要的是"这两栏都别再占半屏" —— 切标签时仍然紧凑，
   * 不必每换一个标签再点一次。
   */
  const [historyCollapsed, setHistoryCollapsed] = useState(false);

  /**
   * **持仓表的弹性伸缩**（2026-10-17 · 用户要求）。
   *
   * 用户原话：
   * > 「下面这块区域增加弹性伸缩：就是像现在（顶满4个的情况下），
   * >  **点击这块区域外，会自动收缩成2栏，点击区域内又可以放大到4栏**」
   *
   * ## 为什么它与 `historyCollapsed` 是两个 state
   *
   * 两件事的**触发方式不同**：
   * ```
   *   historyCollapsed（历史表）：只有"收起"是自动的（点外面），展开要按按钮
   *   positionsCollapsed（持仓表）：**两个方向都跟着点击走** —— 这正是用户描述的
   *                                 "点外面收缩、点里面放大"
   * ```
   * 合成一个 state 会让"点历史表里面"也把它展开，那改变了既有行为。
   *
   * 默认 `false`（展开）：用户第一眼要看的就是持仓，不该先看到两行。
   */
  const [positionsCollapsed, setPositionsCollapsed] = useState(false);

  /**
   * 「表格区域」的两个 DOM 范围 —— 工具栏与表格区，一起算作"里面"。
   *
   * 分成两个 `ref`（而不是把两者包进一个新 div）是刻意的：这一层的 DOM 结构不动，
   * 就不会有任何一行布局跟着变。工具栏**必须**算在里面，否则点「刷新」会被当成
   * "点了外面"，表格在操作者正要继续看它的时候缩掉。
   */
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const tableAreaRef = useRef<HTMLDivElement | null>(null);

  /**
   * 点表格区域之外 → 历史区**自动收起**（用户建议的那条，但**不切标签**）。
   *
   * 用户的原话是"点开以后占太多高度，得手动点回当前持仓才能缩回去"。照他的建议
   * 跳回「当前持仓」会把操作者正在看的那一栏**换掉** —— 他只是想让它矮一点，
   * 不是想离开。所以这里做的是**收起**：位置还在、数据还在，一键就能展开回来。
   *
   * ## 什么情况下**不**收起（宁可不动，也不要打断正当操作）
   *
   *  · **只认左键**（`button !== 0` 一律忽略）：右键是"刚打开上下文菜单"或"正在拖拽"，
   *    中键是滚动 —— 都不是"我看完了"；
   *  · 按下的位置在面板**里面**（工具栏、表头、行、行内按钮、滚动条）→ 完全不管：
   *    滚动、点币种跳行情图、按「平仓」、从表格里往外拖选文字，**起点都在里面**。
   *    这也是为什么监听 `pointerdown`（按下的那一刻）而不是 `click`：拖选文字的
   *    起点在表格里、终点在外面，`click` 会把它当成"点了外面"；
   *  · **任何对话框开着**→ 不管：平仓确认框是 Radix 的 portal，DOM 上本来就落在面板之外，
   *    点遮罩关掉它不该顺手把表格也收了；
   *  · 本来就已经收起 / 当前不是历史类标签 → 监听器根本不挂。
   */
  useEffect(() => {
    if (!isHeavyTab || historyCollapsed) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (toolbarRef.current?.contains(target) || tableAreaRef.current?.contains(target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      setHistoryCollapsed(true);
    };
    // 捕获阶段挂：内层的 `stopPropagation` 管不到它，判断只看"按在了谁身上"。
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [isHeavyTab, historyCollapsed]);

  /**
   * **持仓表的"点外收缩 / 点内放大"**（2026-10-17 · 用户要求）。
   *
   * 与上面那个 effect 是**两件事**，所以两个 effect：
   * ```
   *   上面：历史表 —— 只自动"收起"，展开要靠按钮（既有行为，不动）
   *   这里：持仓表 —— **两个方向都跟点击走**（用户原话"点外面收缩、点里面放大"）
   * ```
   *
   * ## ⚠️ 判据只认【表格区】为"里面"，**工具栏不算**（2026-10-17 实测修正）
   *
   * 第一版把工具栏也算成"里面"，于是每个工具栏按钮的 `pointerdown` 都会先写一次
   * `setPositionsCollapsed(false)`，紧接着按钮自己的 `onClick` 又做一次 `!collapsed` ——
   * **两个更新写同一个 state**。实测（事件探针，见 `.dsh/t68-事件顺序.json`）：
   * 连点开关时高度确实在 306↔144 之间正确翻转，但那依赖 React 对这两次更新的
   * 批处理顺序 —— 属于"**结果对、但依赖一件没被保证的事**"。
   *
   * 现在：**只在表格区**里按下才放大。工具栏里的按钮（收起/展开、刷新、全部平仓、
   * 四个标签）各自管自己的行为，`pointerdown` **完全不碰 state** —— 冲突在结构上消失。
   *
   * 这也更贴用户的话："点击**区域**内放大" —— 他指的是那块表格，不是工具栏。
   *
   * ## 其余判据与上面同一套（照抄它的理由，不另造）
   *
   *  · 只认**左键**：右键/中键不是"我看完了"；
   *  · 按下点在里面 → **放大**；按在外面 → **收缩**；
   *  · **不拦截**这次点击本身（不 `preventDefault`、不 `stopPropagation`）——
   *    点币种跳行情、按「平仓」、翻页、切标签都照常工作；
   *  · **任何对话框开着** → 不管（Radix 的 portal 在 DOM 上落在面板外，
   *    点遮罩关对话框不该顺手把表格收了）；
   *  · 监听 `pointerdown`（按下的那一刻）而不是 `click`：从表格里往外拖选文字，
   *    起点在里面、终点在外面，`click` 会把它误判成"点了外面"。
   *
   * ## 只在这个标签页挂
   *
   * `tab !== 'positions'` 时根本不挂监听器 —— 在「历史成交」页点外面，
   * 不该把持仓表的展开态也一起改掉（那是看不见的副作用）。
   */
  useEffect(() => {
    if (tab !== 'positions') return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      /* 对话框开着 → 完全不管（同上一条理由）。 */
      if (document.querySelector('[role="dialog"]')) return;
      /* 工具栏里按下 → **两件事都不做**：那些按钮自己有 onClick，见上面那段。 */
      if (toolbarRef.current?.contains(target)) return;
      const inTable = tableAreaRef.current?.contains(target) ?? false;
      /* 点在表格**里面** → 放大；点在**外面** → 收缩。 */
      setPositionsCollapsed(!inTable);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [tab]);

  /*
   * 委托数据**唯一的一份**，容器持有。
   *
   * 它同时喂给两个地方：表格的行、以及标签上的「当前委托 N」。以前这两处各读一份
   * （标签读 WebSocket 的 `order` 事件、表格读 REST），于是它们可以互相矛盾 ——
   * 而"上面写 0、下面列十六行"这种矛盾正好发生在这个系统最需要被相信的地方。
   * 一份数据、一个数组，不一致在结构上就不再可能。
   *
   * 代价是这一轮询问在切到别的标签时也会发生（以前只有订单表挂载时才拉）。
   * 25 行的一页、15 秒一次，换来的是标签上的数字与表格永远一致。
   */
  const liveOrders = useEvents((s) => s.byTrader[traderId]?.orders);
  const ordersQuery = usePolled(
    (signal) => api.traderOrders(traderId, { limit: PAGE_LIMIT, signal }),
    { intervalMs: 15_000, deps: [traderId, token] },
  );
  const ordersPaging = useTablePaging<OrderRecord>(
    traderId,
    api.traderOrders,
    ordersQuery,
    liveOrders,
    /*
     * 没有时间排序（订单的 id 顺序就是创建顺序），所以第 5 个参数不传 —— 但第 6 个
     * （重挂信号）必须传：这张表在「当前委托」与「订单记录」两处各挂一次，
     * `tab` 一变 DOM 就被换掉而观察器 effect 不会自己重跑。见 `useTablePaging` 的 `remountKey`。
     */
    undefined,
    tab,
  );
  const openOrders = ordersPaging.rows.filter(isOpenOrder);

  /*
   * 成交数据**也在容器里预取**，理由同上面那一段 —— 但这里还有一条更直接的教训。
   *
   * ⚠️ 原来成交表的数据是**在 `TradesTable` 组件内部**拉的，于是：
   * **数据要等你切过去那一刻才开始请求**，界面必然经历「空白 → 转圈 → 数据」三段跳。
   *
   * 实测（headed 真实窗口，切到「历史成交」）：
   *
   *     23381ms  空白      ← 组件刚挂载
   *     23732ms  转圈      ← 这时才发起请求
   *     24067ms  trades 25行
   *
   * 而「当前委托」不闪，因为它的数据一直在这里、页面加载时就已经拿到。
   * 两者差的不是样式，是"**什么时候开始请求**"。
   */
  const liveTrades = useEvents((s) => s.byTrader[traderId]?.trades);
  const tradesQuery = usePolled(
    (signal) => api.traderTrades(traderId, { limit: PAGE_LIMIT, signal }),
    { intervalMs: 15_000, deps: [traderId, token] },
  );
  const tradesPaging = useTablePaging<TradeRecord>(
    traderId,
    api.traderTrades,
    tradesQuery,
    liveTrades,
    /* 成交按 `closedAt` 排 —— 理由见 `TradesTable` 里那一段（日期错乱的事故）。 */
    (row) => row.closedAt,
    tab,
  );

  const tabs: Array<{ id: TraderTabId; label: string; count?: number }> = [
    { id: 'positions', label: '当前持仓', count: positionCount },
    // 与表格同一个数组，见上面 `ordersPaging` 的说明。
    { id: 'orders', label: '当前委托', count: openOrders.length },
    { id: 'trades', label: '历史成交' },
    { id: 'history', label: '订单记录' },
  ];

  return (
    <Panel padded={false} bodyClassName="p-0">
      <div
        ref={toolbarRef}
        className="flex flex-wrap items-center gap-2 border-b border-base-800 px-3 py-2"
      >
        {/* Real tab semantics, so the arrow keys and the tab order work. */}
        <div role="tablist" aria-label="机器人数据表" className="flex items-center gap-0.5">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => onChange(item.id)}
              className={
                tab === item.id
                  ? '-mb-px border-b-2 border-accent px-3 py-1.5 text-base font-semibold text-ink-hi'
                  : '-mb-px border-b-2 border-transparent px-3 py-1.5 text-base text-ink-lo transition hover:text-ink-mid'
              }
            >
              {item.label}
              {item.count !== undefined && <span className="num ml-1.5 text-xs text-ink-faint">{item.count}</span>}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="danger"
            disabled={positionCount === 0}
            title={positionCount === 0 ? '当前没有持仓' : '查看手工平仓的说明'}
            onClick={() => setCloseTarget('__all__')}
          >
            全部平仓
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOrdersRefreshToken((n) => n + 1)} title="立即刷新表格数据">
            刷新
          </Button>
          {/*
            历史区的收起 / 展开。与 `TraderPage.tsx` 权益曲线那个按钮**同一套交互语言**：
            `variant="ghost" size="sm"` + `aria-expanded` + 文案跟着状态走。

            放在工具栏而不是各表内部：两张历史表是**同一个开关**，而"同一屏上的同一个概念
            只能有一个实现"是这个文件自己的纪律（四张表各写一遍币种单元格吃过一次亏）。
            收起后的手上动作也只有一步 —— 不用点回「当前持仓」。
          */}
          {isHeavyTab && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={!historyCollapsed}
              title={
                historyCollapsed
                  ? '把历史表展开到完整高度（更早的记录仍然在表格里往下滚）'
                  : '把历史表收成几行，给上面的行情 / 决策流让出高度'
              }
              onClick={() => setHistoryCollapsed((collapsed) => !collapsed)}
            >
              {historyCollapsed ? '展开全部' : '收起'}
            </Button>
          )}
          {/*
            **持仓表的显式开关**（2026-10-17 · 用户要求的"弹性伸缩"）。

            用户描述的是**点区域外收缩、点区域内放大**，那套已经实现在上面的
            `pointerdown` 监听里。但**只用点击是不够的**：
            ```
              · 键盘用户没法"点区域外"（焦点移动不产生 pointerdown）；
              · 屏幕阅读器读不到"这块可以伸缩"；
              · 触屏上"点外面"很容易被当成误触。
            ```
            所以补一个**显式按钮**：它与点击**同一个 state**，两条路等价。
            这一条也是 `AGENTS.md` 里"不能只靠鼠标手势表达一个状态"的落实
            （颜色不能单独表达状态 → 手势同样不能）。
          */}
          {tab === 'positions' && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={!positionsCollapsed}
              title={
                positionsCollapsed
                  ? '展开持仓表（也会在点击表格区域时自动展开）'
                  : '把持仓表收成几行，给上面的行情 / 决策流让出高度（点击表格区域外也会自动收起）'
              }
              onClick={() => setPositionsCollapsed((collapsed) => !collapsed)}
            >
              {positionsCollapsed ? '展开' : '收起'}
            </Button>
          )}
        </div>
      </div>

      {/* 空表格不占位：`min-h` 曾经给这一区留了 220px，于是"暂无持仓"下面跟着
          一片空白。高度交给内容，有行时才需要滚动。

          这个 `ref` 只用于"点击区域之外"的判断（见上面那个 `useEffect`），不参与布局。 */}
      <div ref={tableAreaRef}>
        {/*
          ⚠️ **`onSelectSymbol` 必须传** —— 漏过一次。

          `PositionsTable` 一直支持点击币种跳转行情图（它内部用的就是下面三张表同一个
          `SymbolCell`），但这一行**没有把它传进去**：委托表、成交表、订单记录都传了，
          持仓表漏了。于是四张表里唯独最上面那张点了没反应 —— 而它恰恰是操作员最想
          看行情的那一张（手上正拿着这个仓位）。

          `onSelectSymbol` 是可选的，所以漏传**不会报错**，只会静默失去功能。
          这正是四个调用点里最容易漏掉第三个的原因。
        */}
        {tab === 'positions' && (
          <PositionsTable
            traderId={traderId}
            onCloseRequest={setCloseTarget}
            onSelectSymbol={onSelectSymbol}
            /* 收起态（用户要求的"弹性伸缩"）：只换 class，不卸载表格。 */
            collapsed={positionsCollapsed}
          />
        )}
        {/*
          两个标签共用同一个分页实例：它们读的是同一个端点，只是过滤条件不同；
          分开两套只会让翻出来的历史与"当前委托"的数字再次分家。

          ⚠️ **这里原来写成了两个并列的 `{tab === 'orders' && …}{tab === 'history' && …}`，
          那会让两个标签之间有 25 行一闪而过的残留。**

          实测（1600px 视口，点「当前委托」后每 30ms 采一次 DOM）：

              0ms   行=25   ← 还是「订单记录」的内容
              30ms  行= 2   ← 才换成「当前委托」

          成因：两个 `&&` 分支虽然渲染的是同一个组件类型，但它们**在 JSX 里是两个不同的
          位置** —— `tab` 一变，React 把旧的那个**卸载**、新的那个**挂载**，卸载发生在先，
          而浏览器的下一帧仍可能画出旧 DOM。用户的描述是「点进去会快速闪烁出现一堆订单，
          闪完以后又恢复正常」。

          合并成一个条件之后，React 在同一个位置看到**同一个组件类型**，于是**复用同一个实例**
          （只更新 props），中间不存在"旧表格还在、新表格还没上"的那一帧。

          两处的差异只有 `onlyOpen` 与 `collapsed` —— 把它们写成 `tab` 的表达式即可，
          不需要两个 JSX 分支。
        */}
        {(tab === 'orders' || tab === 'history') && (
          <OrdersTable
            paging={ordersPaging}
            onlyOpen={tab === 'orders'}
            positionCount={positionCount}
            paper={paper}
            onSelectSymbol={onSelectSymbol}
            /*
             * 只有「历史」那侧才有收起态：「当前委托」是行动面板（对着它撤单、
             * 确认保护单），行数受挂单数约束，默认就该看得全 —— 见 `isHeavyTab`。
             */
            collapsed={tab === 'history' ? historyCollapsed : undefined}
            liveMarginModes={liveMarginModes}
            liveLeverages={liveLeverages}
          />
        )}
        {tab === 'trades' && (
          <TradesTable
            traderId={traderId}
            refreshToken={token}
            onSelectSymbol={onSelectSymbol}
            collapsed={historyCollapsed}
            /* 容器预取好的那份 —— 切过来时数据已在手上，不会经历"空白 → 转圈"。 */
            paging={tradesPaging}
            /* 「保证金模式」的兜底来源，与订单表共用同一份映射。 */
            liveMarginModes={liveMarginModes}
          />
        )}
      </div>

      {/*
        平仓后要刷新的是**三样东西**，不只是订单表。

        第一版我只加了 `setOrdersRefreshToken` —— 于是手工平仓成功后
        持仓行还留在「当前持仓」里（用户实测报回来的就是这个）。
        `positionCount` 是页面从 WebSocket 里算的，它有自己的更新节奏，
        **不能指望它"过一会儿自己会好"**：操作员按了平仓、界面却还显示着那个仓，
        他会以为没平掉，然后再按一次。
      */}
      <ClosePositionModal
        traderId={traderId}
        target={closeTarget}
        symbols={positionSymbols}
        onClose={() => setCloseTarget(null)}
        onDone={() => {
          setOrdersRefreshToken((n) => n + 1);
          onPositionsChanged?.();
        }}
      />
    </Panel>
  );
}
