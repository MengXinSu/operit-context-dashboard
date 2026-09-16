// Based on dsh-context (https://github.com/bowenliang123/dsh-context, Apache-2.0); modified for the Operit platform.
/**
 * 文件活动卡：一个范围里 agent 对用户的文件「做了什么」——不是上下文由什么构成
 * （消息），而是工具对文件的读写搜。每个被触碰的文件一行：读写搜计数、行数增减、
 * 错误点、form 图标（文本 / 图片 / 目录）；头部 chips 兼作目的/形态筛选，搜索框
 * 按路径过滤；点行展开该文件自己的操作日志（树轨）。
 *
 * Operit 移植差异：无 workspace 相对化（路径即绝对路径，完整显示换行）；无右栏
 * 预览 / 系统打开（文件名不可点）；无时间显示（raw 无时间戳，归 W6 决策）。
 * W3：操作行可点（onLocate）→ 浏览器展开对应工具结果。
 */
import { memo, useMemo, useState, type ChangeEvent, type ReactElement, type ReactNode } from 'react'
import { EMPTY_FA_TOTALS, type FileActivityData, type FileActivityEntry, type FileActivityOp, type FileActivityTotals } from '../../data/bridge'
import type { ViewKit } from '../viewkit'

export type FileFilter = 'all' | 'read' | 'write' | 'search' | 'image'

export interface FileCardProps {
  /** 桥 v2 聚合结果（entries + totals）；null = 无数据（demo / 读取失败）。 */
  activity: FileActivityData | null
  /** 首次数据读取在途：显示加载条而非误导性的空态。 */
  loading?: boolean
  /** 数据读取失败：配合 onRetry 显示失败重试条。 */
  failed?: boolean
  /** 失败重试；缺省时失败态只显示纯文本。 */
  onRetry?: () => void
  /** W3 定位联动：点操作行 → 浏览器展开对应工具结果；缺省时操作行不可点。 */
  onLocate?: (op: FileActivityOp) => void
  /** W4 排序受控：默认值来自设置卡持久化偏好；卡内切换经 onSortChange 回写。 */
  sort: 'count' | 'latest' | 'path'
  onSortChange: (sort: 'count' | 'latest' | 'path') => void
  /** W6 scope：数据范围副标题（缺省「截至最新 ·跟随趋势图的选择」）。 */
  scopeText?: string
  /** W6 scope：过滤边界（preparedHistory 下标）——只显示 resultIdx < before 的操作；缺省 = 不过滤。 */
  beforeIdx?: number | null
  /** W6 scope：选中轮早于数据窗口 → 内容区显示提示。 */
  scopeOut?: boolean
  /** W6：点击文件名回调（pattern / 目录不触发；缺省 = 文件名不可点）。 */
  onOpen?: (path: string) => void
  /** W6 时间：[[USER 锚点下标, 该轮时间戳]…]（升序）；缺省 = 不显示时间。 */
  timeBands?: Array<[number, number]> | null
}

// ── 行图标（移植上游 fileActivity.ts 的 glyphOf：目录桶 / 扩展名桶 / 语言色卡）──

interface FileGlyph {
  glyph: string
  tip: string
  /** 语言色卡填充；仅代码文件桶带。 */
  color?: string
  /** 色卡文字色（随 color 同行；浅底近黑 / 深底白）。 */
  text?: string
}

/** 目录桶，按末段路径名（小写，显式复数）。按序检查，然后隐藏目录，最后普通文件夹。 */
const DIR_BUCKETS: (readonly [readonly string[], string, string])[] = [
  [['test', 'tests', '__tests__', 'spec', 'specs', 'e2e'], '🧪', 'files.glyph.tests'],
  [['doc', 'docs', 'documentation'], '📚', 'files.glyph.docs'],
  [['node_modules', 'vendor', 'third_party', 'third-party', 'packages'], '📦', 'files.glyph.deps'],
  [['dist', 'build', 'out', 'target', 'release', 'debug', 'coverage', 'artifacts'], '🏗️', 'files.glyph.build'],
  [['scripts', 'tools', 'bin'], '🛠️', 'files.glyph.scripts'],
  [['config', 'configs', 'settings', '.config'], '⚙️', 'files.glyph.config'],
  [['assets', 'static', 'public', 'images', 'fonts', 'icons', 'media'], '🎨', 'files.glyph.assets'],
]

/** 非代码文件的扩展名桶，最具体的在前。 */
const EXT_BUCKETS: (readonly [readonly string[], string, string])[] = [
  [['yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env'], '⚙️', 'files.glyph.config'],
  [['json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'xml'], '🧾', 'files.glyph.data'],
  [['md', 'mdx', 'markdown', 'rst', 'adoc', 'org'], '📝', 'files.glyph.markdown'],
  [['log'], '📜', 'files.glyph.log'],
  [['csv', 'tsv', 'xls', 'xlsx', 'ods'], '📊', 'files.glyph.sheet'],
  [['pdf', 'doc', 'docx', 'odt', 'rtf'], '📕', 'files.glyph.document'],
  [['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'jar'], '🗜️', 'files.glyph.archive'],
  [['ttf', 'otf', 'woff', 'woff2', 'eot'], '🔤', 'files.glyph.font'],
  [['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'ogg'], '🎬', 'files.glyph.media'],
]

/** 不以 .lock 结尾的锁文件名。 */
const LOCK_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']
const MAKE_NAMES = ['makefile', 'justfile', 'cmakelists.txt']
/** 测试文件特征：独立或分隔的 `test`，或内联 `.test.`。 */
const TEST_NAME = /(^|[^a-z0-9])test([^a-z0-9]|$)|\.test\./

/**
 * 编程语言文件渲染为语言色卡字母徽章（GitHub Linguist 色）。在 emoji 桶之前检查，
 * 语言文件绝不落入 emoji 桶。
 */
const CODE_LANGS: (readonly [readonly string[], string, string, string])[] = [
  [['tsx'], 'TSX', '#3178c6', 'files.glyph.lang.ts'],
  [['ts'], 'TS', '#3178c6', 'files.glyph.lang.ts'],
  [['js', 'jsx', 'mjs', 'cjs'], 'JS', '#f7df1e', 'files.glyph.lang.js'],
  [['py', 'pyi', 'pyw'], 'PY', '#3572a5', 'files.glyph.python'],
  [['ipynb'], 'NB', '#da5b0b', 'files.glyph.notebook'],
  [['go'], 'GO', '#00add8', 'files.glyph.lang.go'],
  [['rs'], 'RS', '#dea584', 'files.glyph.lang.rust'],
  [['java'], 'JV', '#b07219', 'files.glyph.lang.java'],
  [['kt', 'kts'], 'KT', '#a97bff', 'files.glyph.lang.kotlin'],
  [['rb'], 'RB', '#701516', 'files.glyph.lang.ruby'],
  [['php'], 'PHP', '#4f5d95', 'files.glyph.lang.php'],
  [['c', 'h'], 'C', '#555555', 'files.glyph.lang.c'],
  [['cpp', 'cc', 'cxx', 'hpp'], 'C++', '#f34b7d', 'files.glyph.lang.cpp'],
  [['cs'], 'C#', '#178600', 'files.glyph.lang.csharp'],
  [['scala'], 'SC', '#c22d40', 'files.glyph.lang.scala'],
  [['lua'], 'LUA', '#000080', 'files.glyph.lang.lua'],
  [['dart'], 'DA', '#00b4ab', 'files.glyph.lang.dart'],
  [['swift'], 'SW', '#f05138', 'files.glyph.lang.swift'],
  [['vue'], 'VUE', '#41b883', 'files.glyph.lang.vue'],
  [['svelte'], 'SV', '#ff3e00', 'files.glyph.lang.svelte'],
  [['sh', 'bash', 'zsh', 'fish', 'ps1'], 'SH', '#89e051', 'files.glyph.shell'],
  [['html', 'htm', 'xhtml'], 'HT', '#e34c26', 'files.glyph.lang.html'],
  [['css', 'scss', 'sass', 'less', 'styl'], 'CSS', '#563d7c', 'files.glyph.style'],
  [['sql'], 'SQL', '#e38c00', 'files.glyph.database'],
]

/** 按填充色亮度选文字色：深底白、浅底近黑（JS 黄 / shell 绿）——固定近黑而非纯黑。 */
function badgeTextColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return luminance < 0.6 ? '#ffffff' : '#1f2328'
}

function dirGlyph(base: string): FileGlyph {
  if (base === '' || base === '.') return { glyph: '🏠', tip: 'files.glyph.root' }
  const name = base.toLowerCase()
  for (const [names, glyph, tip] of DIR_BUCKETS) {
    if (names.includes(name)) return { glyph, tip }
  }
  if (name.startsWith('.')) return { glyph: '🗄️', tip: 'files.glyph.hidden' }
  return { glyph: '📁', tip: 'files.form.dir' }
}

function fileGlyph(base: string): FileGlyph {
  const name = base.toLowerCase()
  const dot = name.lastIndexOf('.')
  // 位置 0 的点是 dotfile 而非扩展名——`.env` 走下面的名字表。
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  if (name.endsWith('.lock') || LOCK_NAMES.includes(name)) return { glyph: '🔒', tip: 'files.glyph.lock' }
  if (TEST_NAME.test(name)) return { glyph: '🧪', tip: 'files.glyph.tests' }
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return { glyph: '🐳', tip: 'files.glyph.docker' }
  if (MAKE_NAMES.includes(name)) return { glyph: '🛠️', tip: 'files.glyph.scripts' }
  if (name === '.gitignore' || name === '.gitattributes') return { glyph: '🚫', tip: 'files.glyph.ignore' }
  if (name === 'license' || name.startsWith('license.') || name === 'copying') return { glyph: '⚖️', tip: 'files.glyph.license' }
  if (name === '.env' || name.startsWith('.env.')) return { glyph: '⚙️', tip: 'files.glyph.config' }
  if (ext !== '') {
    for (const [exts, label, color, tip] of CODE_LANGS) {
      if (exts.includes(ext)) return { glyph: label, tip, color, text: badgeTextColor(color) }
    }
    for (const [exts, glyph, tip] of EXT_BUCKETS) {
      if (exts.includes(ext)) return { glyph, tip }
    }
  }
  return { glyph: '📄', tip: 'files.form.text' }
}

/** 一个文件条目的行图标：form 优先（图片/目录），然后走文件名表。 */
function glyphOf(path: string, form: FileActivityEntry['form']): FileGlyph {
  if (form === 'image') return { glyph: '🖼', tip: 'files.form.image' }
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return form === 'dir' ? dirGlyph(base) : fileGlyph(base)
}

/** W6 scope：过滤态按锚点重聚合 ops 的每文件计数（无过滤不走这条，回归不变）。 */
function refoldByBefore(entries: FileActivityEntry[], before: number): FileActivityEntry[] {
  const out: FileActivityEntry[] = []
  for (const e of entries) {
    const ops = e.ops.filter((o) => o.resultIdx < before)
    if (ops.length === 0) continue
    let reads = 0, writes = 0, searches = 0, added = 0, removed = 0, errs = 0
    for (const o of ops) {
      if (o.kind === 'read') reads++
      else if (o.kind === 'write') writes++
      else searches++
      added += o.added || 0
      removed += o.removed || 0
      if (o.err) errs++
    }
    out.push({ ...e, reads, writes, searches, added, removed, errs, ops })
  }
  return out
}
/** W6 scope：过滤态从 entries 重算 chips 总量（口径对齐桥聚合）。 */
function totalsOfEntries(entries: FileActivityEntry[]): FileActivityTotals {
  const totals: FileActivityTotals = { read: { files: 0, ops: 0 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 }
  for (const e of entries) {
    if (e.reads > 0) { totals.read.files++; totals.read.ops += e.reads }
    if (e.writes > 0) { totals.write.files++; totals.write.ops += e.writes }
    if (e.searches > 0) { totals.search.files++; totals.search.ops += e.searches }
    if (e.form === 'image') { totals.image.files++; totals.image.ops += e.ops.length }
    totals.added += e.added
    totals.removed += e.removed
  }
  return totals
}
/** W6 时间：resultIdx → 所在轮的快照时间（bands 升序，线性回扫；无匹配 = null）。 */
function timeOf(bands: Array<[number, number]>, idx: number): number | null {
  for (let i = bands.length - 1; i >= 0; i--) {
    if (bands[i][0] <= idx) return bands[i][1]
  }
  return null
}

export function makeFileCard(kit: ViewKit): (props: FileCardProps) => ReactNode {
  const { t, fmt, fmtTime } = kit

  function matches(e: FileActivityEntry, f: FileFilter): boolean {
    if (f === 'all') return true
    if (f === 'image') return e.form === 'image'
    if (f === 'read') return e.reads > 0
    if (f === 'write') return e.writes > 0
    return e.searches > 0
  }

  /** 带符号行数对：增长走成功色、收缩走错误色（diff 语义）。 */
  function DeltaPair(props: { added: number; removed: number }): ReactElement {
    return (
      <span className="lc-fa-delta">
        {props.added > 0 ? <span className="lc-fa-up">{'+' + fmt(props.added)}</span> : null}
        {props.removed > 0 ? <span className="lc-fa-down">{'−' + fmt(props.removed)}</span> : null}
      </span>
    )
  }

  // memo：App 的其它交互（趋势图 hover / 选中）重渲染时，输入未变则跳过。
  return memo(function FileCard(props: FileCardProps): ReactElement {
    const filtering = props.beforeIdx !== undefined && props.beforeIdx !== null
    // W6 scope：过滤态 = ops 按锚点重聚合（计数/总量重算）；无过滤 = 桥聚合原样。
    const entries = useMemo(() => {
      const all = props.activity ? props.activity.entries : []
      return filtering ? refoldByBefore(all, props.beforeIdx as number) : all
    }, [props.activity, filtering, props.beforeIdx])
    const totals = useMemo(() => {
      if (!filtering) return props.activity ? props.activity.totals : EMPTY_FA_TOTALS
      return totalsOfEntries(entries)
    }, [filtering, props.activity, entries])
    const [filter, setFilter] = useState<FileFilter>('all')
    // W4：排序受控——默认值由设置卡持久化偏好传入，卡内切换经 onSortChange 回写。
    const sort = props.sort
    const [query, setQuery] = useState('')
    const [openPath, setOpenPath] = useState<string | null>(null)

    const q = query.trim().toLowerCase()
    // 次数排序的量纲：选中某类芯片时按该类的次数（读芯片下写多的文件不该压过读多的），否则按总 op 数。
    const countOf = (e: FileActivityEntry): number =>
      filter === 'read' ? e.reads : filter === 'write' ? e.writes : filter === 'search' ? e.searches : e.ops.length
    // fold 给的 entries 最新在前；排序只改过滤副本（不动源数组）。
    const shown = entries
      .filter(e => matches(e, filter) && (q === '' || e.path.toLowerCase().includes(q)))
      .sort((a, b) => sort === 'count'
        ? (countOf(b) - countOf(a)) || (b.ops[0].seq - a.ops[0].seq)
        : sort === 'latest'
          ? b.ops[0].seq - a.ops[0].seq
          // 路径是唯一的 map 键：两向比较是全序。
          : (a.path < b.path ? -1 : 1))

    const canOpen = (en: FileActivityEntry): boolean => props.onOpen !== undefined && en.pattern !== true && en.form !== 'dir'
    /** W6 时间：op 行时间文本（无映射 = 「—」；未启用时间 = 空串不渲染）。 */
    const opTimeText = (op: FileActivityOp): string => {
      if (!props.timeBands) return ''
      const tt = timeOf(props.timeBands, op.resultIdx)
      return tt === null ? '—' : fmtTime(tt)
    }
    const chips: { key: FileFilter; files: number; ops: number }[] = [
      {
        key: 'all',
        files: entries.length,
        ops: totals.read.ops + totals.write.ops + totals.search.ops,
      },
      { key: 'read', files: totals.read.files, ops: totals.read.ops },
      { key: 'write', files: totals.write.files, ops: totals.write.ops },
      { key: 'search', files: totals.search.files, ops: totals.search.ops },
      { key: 'image', files: totals.image.files, ops: totals.image.ops },
    ]

    const opLine = (op: FileActivityOp): ReactElement => (
      <>
        <span className="lc-fa-op-tool" title={op.tool}>{op.tool}</span>
        {/* 读取窗口：结果 meta 的精确 `>>n`，或 limit 估算的 ≈n。 */}
        {op.read !== undefined
          ? (
            <span
              className="lc-fa-read"
              title={'est' in op.read
                ? t('files.readEst')
                : t('files.readTip', { a: fmt(op.read.start), b: fmt(op.read.start + op.read.count - 1) })}
            >
              {('est' in op.read ? '≈' : '>>') + fmt(op.read.count)}
            </span>
          )
          : null}
        {op.detail !== undefined ? <span className="lc-fa-op-detail">{op.detail}</span> : null}
        {op.hits !== undefined ? <span className="lc-fa-op-detail">{t('files.hits', { n: fmt(op.hits) })}</span> : null}
        {op.added + op.removed > 0 ? <DeltaPair added={op.added} removed={op.removed} /> : null}
        {op.err ? <span className="lc-br-err-dot" title={t('node.failed')} /> : null}
        {props.timeBands ? <span className="lc-fa-op-time">{opTimeText(op)}</span> : null}
      </>
    )

    return (
      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('files.title')}</span>
          <span className="lc-card-sub">{props.scopeText || t('files.scopeLatest')}</span>
        </div>
        {props.scopeOut ? (
          <div className="lc-empty">{t('files.scopeOut')}</div>
        ) : entries.length === 0 && props.loading ? (
          <div className="lc-empty">{t('detail.loading')}</div>
        ) : entries.length === 0 && props.failed ? (
          <div className="lc-empty">
            {props.onRetry !== undefined
              ? <button type="button" className="lc-error-retry" onClick={props.onRetry}>{t('detail.loadFailed')}</button>
              : t('detail.loadFailed')}
          </div>
        ) : entries.length === 0 ? (
          <div className="lc-empty">{t('files.empty')}</div>
        ) : (
          <div>
            <div className="lc-fa-ctl">
              {/* 五个目的芯片（标签 + 计数）在窄卡上折行而不是溢出卡缘。 */}
              <div className="lc-gran @max-[380px]/lc-card:flex-wrap">
                {chips.map(c => (
                  <button
                    key={c.key}
                    type="button"
                    // 目的芯片在任何状态都带自己的徽章色（行内 pill 同款）。
                    className={'lc-gran-btn' + (filter === c.key ? ' lc-gran-on' : '')
                      + (c.key === 'read' || c.key === 'write' || c.key === 'search' ? ' lc-fa-chip-' + c.key : '')}
                    title={t('files.chipTip', { files: c.files, ops: c.ops })}
                    onClick={() => { setFilter(cur => (cur === c.key ? 'all' : c.key)) }}
                  >
                    {t('files.kind.' + c.key)}
                    <b className="lc-fa-n">{fmt(c.ops)}</b>
                  </button>
                ))}
              </div>
              <input
                className="lc-fa-search focus:border-(--dsw-alias-label-dimmed)"
                value={query}
                placeholder={t('files.search')}
                onChange={(ev: ChangeEvent<HTMLInputElement>) => { setQuery(ev.target.value) }}
              />
            </div>
            <div className="lc-fa-meta">
              <span>{t('files.files', { n: entries.length })}</span>
              {totals.added + totals.removed > 0 ? (
                /* 卡内唯一样式化气泡：位于滚动列表之外，气泡永不被裁切。 */
                <span className="lc-fa-meta-delta group/tip">
                  <DeltaPair added={totals.added} removed={totals.removed} />
                  <span className="lc-tip lc-fa-meta-tip group-hover/tip:opacity-100" role="tooltip">{t('files.deltaTip')}</span>
                </span>
              ) : null}
              <span className="lc-gran lc-fa-sort" role="group" title={t('files.sortTip')}>
                {(['count', 'latest', 'path'] as const).map(k => (
                  <button
                    key={k}
                    type="button"
                    className={'lc-gran-btn' + (sort === k ? ' lc-gran-on' : '')}
                    onClick={() => { props.onSortChange(k) }}
                  >
                    {t('files.sort.' + k)}
                  </button>
                ))}
              </span>
            </div>
            {shown.length === 0 ? (
              <div className="lc-empty">{t('files.noMatch')}</div>
            ) : (
              <div className="lc-fa-list">
                {shown.map((e) => {
                  const open = openPath === e.path
                  // 路径直接完整显示（Operit 无 workspace 相对化；手机无 hover 可看 title）。
                  const display = e.path
                  const trimmed = display.endsWith('/') ? display.slice(0, -1) : display
                  const slash = trimmed.lastIndexOf('/')
                  const dir = slash >= 0 ? trimmed.slice(0, slash + 1) : ''
                  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
                  const glyph = glyphOf(e.path, e.form)
                  const eT = props.timeBands && e.ops.length > 0 ? timeOf(props.timeBands, e.ops[0].resultIdx) : null
                  return (
                    <div key={e.path} className={'lc-fa-item' + (open ? ' lc-fa-item-on' : '')}>
                      <button
                        type="button"
                        className="lc-fa-row hover:bg-(--dsw-alias-interactive-bg-hover) @max-[380px]/lc-card:flex-wrap"
                        title={e.path}
                        onClick={() => { setOpenPath(open ? null : e.path) }}
                      >
                        <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')} />
                        <span className="lc-fa-form" title={t(glyph.tip)}>
                          {glyph.color !== undefined
                            ? (
                              <span className="lc-fa-lang" style={{ background: glyph.color, color: glyph.text }}>
                                {glyph.glyph}
                              </span>
                            )
                            : glyph.glyph}
                        </span>
                        {/* 窄卡折行而不是压碎：路径的近全宽 basis 保首行只有 chevron + 图标 + 路径，
                            徽章/增减折到第二行。46px 预留 = chevron (12) + 间距 (2×7) + form 图标 (20)。 */}
                        <span className="lc-fa-path flex-1 @max-[380px]/lc-card:basis-[calc(100%-46px)]">
                          {dir !== '' ? <em>{dir}</em> : null}
                          {canOpen(e)
                  ? (
                    <b className="lc-fa-file"
                      title={t('files.open')}
                      onClick={(ev) => { ev.stopPropagation(); props.onOpen!(e.path) }}
                    >
                      {base}
                    </b>
                  )
                  : <b>{base}</b>}
                        </span>
                        {e.reads > 0 ? (
                          <span className="lc-fa-badge lc-fa-b-read" title={t('files.kind.read')}><i />{fmt(e.reads)}</span>
                        ) : null}
                        {e.writes > 0 ? (
                          <span className="lc-fa-badge lc-fa-b-write" title={t('files.kind.write')}><i />{fmt(e.writes)}</span>
                        ) : null}
                        {e.searches > 0 ? (
                          <span className="lc-fa-badge lc-fa-b-search" title={t('files.kind.search')}><i />{fmt(e.searches)}</span>
                        ) : null}
                        {e.added + e.removed > 0 ? <DeltaPair added={e.added} removed={e.removed} /> : null}
                        {e.errs > 0 ? <span className="lc-br-err-dot" title={t('files.errs', { n: e.errs })} /> : null}
                        {props.timeBands ? <span className="lc-fa-time">{eT ? fmtTime(eT) : '—'}</span> : null}
                      </button>
                      {open ? (
                        <div className="lc-fa-ops">
                          {e.ops.map((op, i) => (
                            // 元数据归属的搜索会从一条结果里按命中文件逐行——ops 共享该结果的 seq，key 带上序号。
                            <div
                              key={`${op.seq}:${i}`}
                              className={'lc-fa-op' + (props.onLocate ? ' lc-fa-op-loc' : '')}
                              role={props.onLocate ? 'button' : undefined}
                              onClick={props.onLocate ? () => { props.onLocate!(op) } : undefined}
                            >{opLine(op)}</div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    )
  })
}
