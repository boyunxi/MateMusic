import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Clock3, FolderInput, Heart, Music2, Play, SearchX, Shuffle, Sparkles, Trash2, Upload } from "lucide-react";
import type { Track } from "../types";
import { useActions, useCurrentTrack, usePlayer, useTrackLookup } from "../store/PlayerStore";
import { CURATED_PLAYLISTS, PRESET_TRACKS } from "../data/presets";
import { formatDurationLong } from "../lib/utils";
import { cn } from "../utils/cn";
import { Cover, Select, SPRING } from "./ui";
import { TrackTable } from "./TrackTable";
import { inTauri } from "../lib/tauri";

type SourceFilter = "all" | "preset" | "local";
type SortKey = "default" | "title" | "artist" | "duration" | "added";

function useFiltered(list: Track[], source: SourceFilter, sort: SortKey) {
  const { search } = usePlayer();
  return useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = list.filter((t) => source === "all" || t.source === source);
    if (q) out = out.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
    const collator = new Intl.Collator("zh-CN");
    if (sort === "title") out = [...out].sort((a, b) => collator.compare(a.title, b.title));
    if (sort === "artist") out = [...out].sort((a, b) => collator.compare(a.artist, b.artist));
    if (sort === "duration") out = [...out].sort((a, b) => a.duration - b.duration);
    if (sort === "added") out = [...out].sort((a, b) => b.addedAt - a.addedAt);
    return out;
  }, [list, source, sort, search]);
}

function Empty({ icon: Icon, title, desc, action }: { icon: typeof Music2; title: string; desc: string; action?: React.ReactNode }) {
  return (
    <div className="flex max-w-sm flex-col items-center text-center">
      <div className="neu-btn mb-4 grid h-16 w-16 shrink-0 place-items-center rounded-2xl">
        <Icon className="h-7 w-7 text-accent" />
      </div>
      <p className="text-[15px] font-semibold">{title}</p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/50">{desc}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

function PrimaryAction({ icon: Icon, children, onClick, variant = "primary" }: { icon: typeof Play; children: React.ReactNode; onClick: () => void; variant?: "primary" | "neu" }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-5 text-[13px] font-semibold",
        variant === "primary" ? "neu-primary text-black/85" : "neu-btn text-white/90",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", variant === "primary" && "fill-current")} />
      {children}
    </button>
  );
}

/* ---------------- Banner ---------------- */
function FeaturedBanner({ list }: { list: Track[] }) {
  const s = usePlayer();
  const a = useActions();
  const current = useCurrentTrack();
  const featured = current ?? PRESET_TRACKS[0];
  const total = s.tracks.reduce((acc, t) => acc + (t.duration || 0), 0);
  const ids = list.map((t) => t.id);
  return (
    <section className="glass mm-sheen relative flex h-[176px] shrink-0 items-center gap-6 overflow-hidden rounded-[22px] px-6">
      <div className="pointer-events-none absolute inset-0">
        <img src={featured.cover} alt="" className="absolute -right-10 top-1/2 h-[340px] w-[340px] -translate-y-1/2 rounded-full object-cover opacity-30 blur-2xl" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/30 via-transparent to-transparent" />
      </div>
      <motion.div key={featured.id} initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} transition={SPRING} className="relative shrink-0">
        <Cover src={featured.cover} alt={featured.title} seed={featured.id} className="h-[128px] w-[128px] rounded-2xl shadow-[0_18px_40px_rgba(0,0,0,0.55),inset_0_1px_1px_rgba(255,255,255,0.3)]" />
        <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/20" />
      </motion.div>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{current ? "正在播放 · Now Playing" : "今日精选 · Featured"}</span>
        </span>
        <h1 className="mt-1.5 truncate text-[30px] font-bold leading-tight tracking-tight">{featured.title}</h1>
        <p className="mt-0.5 truncate text-[13px] text-white/55">
          {featured.artist} · {featured.album}
        </p>
        <div className="mt-4 flex min-w-0 items-center gap-2.5">
          <PrimaryAction icon={Play} onClick={() => ids.length && a.playTrack(ids[0], ids)}>
            播放全部
          </PrimaryAction>
          <PrimaryAction
            icon={Shuffle}
            variant="neu"
            onClick={() => {
              if (!ids.length) return;
              a.setLoop("shuffle");
              a.playTrack(ids[Math.floor(Math.random() * ids.length)], ids);
            }}
          >
            随机播放
          </PrimaryAction>
          <PrimaryAction icon={Upload} variant="neu" onClick={() => void a.pickFiles()}>
            导入本地音乐
          </PrimaryAction>
        </div>
      </div>
      <div className="relative hidden shrink-0 flex-col gap-2 xl:flex">
        {[
          { k: "曲目", v: `${s.tracks.length} 首` },
          { k: "总时长", v: formatDurationLong(total) },
          { k: "收藏", v: `${s.liked.length} 首` },
        ].map((x) => (
          <div key={x.k} className="glass-soft flex h-[42px] w-[150px] items-center justify-between rounded-xl px-3">
            <span className="shrink-0 text-[11.5px] text-white/45">{x.k}</span>
            <span className="truncate text-[13px] font-semibold tabular-nums">{x.v}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------- Generic header ---------------- */
function ViewHeader({ art, eyebrow, title, desc, actions }: { art: React.ReactNode; eyebrow: string; title: string; desc: string; actions?: React.ReactNode }) {
  return (
    <section className="glass mm-sheen relative flex h-[148px] shrink-0 items-center gap-5 overflow-hidden rounded-[22px] px-6">
      <div className="relative shrink-0">{art}</div>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">{eyebrow}</span>
        <h1 className="mt-1 truncate text-[26px] font-bold tracking-tight">{title}</h1>
        <p className="mt-0.5 truncate text-[12.5px] text-white/50">{desc}</p>
        {actions && <div className="mt-3 flex min-w-0 items-center gap-2.5">{actions}</div>}
      </div>
    </section>
  );
}

function IconArt({ icon: Icon, gradient }: { icon: typeof Heart; gradient: string }) {
  return (
    <div className="grid h-[100px] w-[100px] shrink-0 place-items-center rounded-2xl shadow-[0_16px_36px_rgba(0,0,0,0.5),inset_0_1px_1px_rgba(255,255,255,0.4)]" style={{ background: gradient }}>
      <Icon className="h-10 w-10 text-white drop-shadow-lg" />
    </div>
  );
}

/* ---------------- Filter bar ---------------- */
function FilterBar({ source, setSource, sort, setSort, count, showSource }: { source: SourceFilter; setSource: (s: SourceFilter) => void; sort: SortKey; setSort: (s: SortKey) => void; count: number; showSource: boolean }) {
  const { search } = usePlayer();
  const tabs: { k: SourceFilter; l: string }[] = [
    { k: "all", l: "全部" },
    { k: "preset", l: "精选音源" },
    { k: "local", l: "本地文件" },
  ];
  return (
    <div className="flex h-11 shrink-0 items-center gap-3">
      {showSource && (
        <div className="glass-soft flex h-9 shrink-0 items-center rounded-full p-1">
          {tabs.map((t) => (
            <button
              key={t.k}
              onClick={() => setSource(t.k)}
              className={cn("relative h-7 shrink-0 whitespace-nowrap rounded-full px-3.5 text-[12.5px] font-medium transition-colors", source === t.k ? "text-black/85" : "text-white/60 hover:text-white")}
            >
              {source === t.k && <motion.span layoutId="src-pill" transition={SPRING} className="absolute inset-0 rounded-full bg-gradient-to-r from-accent to-accent2 shadow-[inset_0_1px_1px_rgba(255,255,255,0.5)]" />}
              <span className="relative">{t.l}</span>
            </button>
          ))}
        </div>
      )}
      <span className="min-w-0 truncate text-[12.5px] text-white/45">
        {search ? (
          <>
            搜索 “<span className="text-white/80">{search}</span>” · <span className="tabular-nums">{count}</span> 个结果
          </>
        ) : (
          <>
            共 <span className="tabular-nums">{count}</span> 首
          </>
        )}
      </span>
      <div className="flex-1" />
      <span className="shrink-0 text-[12px] text-white/40">排序</span>
      <Select<SortKey>
        value={sort}
        onChange={setSort}
        width="w-36"
        options={[
          { value: "default", label: "默认顺序" },
          { value: "title", label: "按标题" },
          { value: "artist", label: "按歌手" },
          { value: "duration", label: "按时长" },
          { value: "added", label: "最近添加" },
        ]}
      />
    </div>
  );
}

/* ---------------- Playlists grid ---------------- */
function PlaylistsGrid() {
  const s = usePlayer();
  const a = useActions();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4 pb-2">
        {CURATED_PLAYLISTS.map((p, i) => {
          const items = s.tracks.filter(p.match);
          return (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...SPRING, delay: i * 0.05 }}
              onClick={() => a.openPlaylist(p.id)}
              className="glass group relative flex cursor-pointer flex-col overflow-hidden rounded-[22px] p-3.5 transition-transform hover:-translate-y-1"
            >
              <div className="relative aspect-square w-full shrink-0 overflow-hidden rounded-2xl" style={{ background: p.gradient }}>
                <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-0.5 p-0 opacity-90">
                  {items.slice(0, 4).map((t) => (
                    <Cover key={t.id} src={t.cover} alt="" seed={t.id} className="h-full w-full" />
                  ))}
                </div>
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (items.length) a.playTrack(items[0].id, items.map((t) => t.id));
                    else a.toast("这个歌单还没有歌曲", "info");
                  }}
                  className="neu-primary absolute bottom-3 right-3 grid h-11 w-11 shrink-0 translate-y-2 place-items-center rounded-full text-black/85 opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100"
                  aria-label="播放歌单"
                >
                  <Play className="ml-0.5 h-5 w-5 fill-current" />
                </button>
              </div>
              <div className="mt-3 flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{p.name}</span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-white/40">{items.length} 首</span>
              </div>
              <p className="mt-0.5 truncate text-[12px] text-white/45">{p.desc}</p>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- View ---------------- */
export function LibraryView() {
  const s = usePlayer();
  const a = useActions();
  const lookup = useTrackLookup();
  const [source, setSource] = useState<SourceFilter>("all");
  const [sort, setSort] = useState<SortKey>("default");
  const playlist = CURATED_PLAYLISTS.find((p) => p.id === s.activePlaylist);

  const base = useMemo(() => {
    switch (s.nav) {
      case "local":
        return s.tracks.filter((t) => t.source === "local");
      case "recent":
        return lookup(s.recent);
      case "liked":
        return lookup(s.liked);
      case "playlists":
        return playlist ? s.tracks.filter(playlist.match) : [];
      default:
        return s.tracks;
    }
  }, [s.nav, s.tracks, s.recent, s.liked, playlist, lookup]);

  const list = useFiltered(base, s.nav === "library" ? source : "all", sort);
  const ids = list.map((t) => t.id);
  const playAll = () => ids.length && a.playTrack(ids[0], ids);
  const viewKey = `${s.nav}:${s.activePlaylist ?? ""}`;
  const totalDur = formatDurationLong(base.reduce((x, t) => x + (t.duration || 0), 0));

  const searchEmpty = s.search ? <Empty icon={SearchX} title="没有找到匹配的歌曲" desc="试试其他关键词，或清空搜索查看全部曲目。" action={<PrimaryAction icon={SearchX} variant="neu" onClick={() => a.setSearch("")}>清空搜索</PrimaryAction>} /> : null;

  let header: React.ReactNode = null;
  let empty: React.ReactNode = null;
  if (s.nav === "library") {
    header = <FeaturedBanner list={list} />;
    empty = searchEmpty ?? <Empty icon={Music2} title="这里还没有歌曲" desc="切换筛选条件，或导入你的本地音乐。" action={<PrimaryAction icon={Upload} onClick={() => void a.pickFiles()}>导入本地音乐</PrimaryAction>} />;
  } else if (s.nav === "local") {
    header = (
      <ViewHeader
        art={<IconArt icon={FolderInput} gradient="linear-gradient(135deg,#22d3ee,#6366f1)" />}
        eyebrow="Local Library"
        title="本地导入"
        desc={
          inTauri
            ? `${base.length} 首本地歌曲 · ${totalDur} · 曲库保存在本机 SQLite，由 Rust 音频核心直通输出`
            : `${base.length} 首本地歌曲 · ${totalDur} · 支持拖拽 MP3 / FLAC / WAV 及同名 .lrc 歌词到窗口任意位置`
        }
        actions={
          <>
            <PrimaryAction icon={Upload} onClick={() => void a.pickFiles()}>选择文件</PrimaryAction>
            {inTauri && <PrimaryAction icon={FolderInput} variant="neu" onClick={() => void a.pickFolder()}>扫描文件夹</PrimaryAction>}
            {base.length > 0 && <PrimaryAction icon={Play} variant="neu" onClick={playAll}>播放全部</PrimaryAction>}
          </>
        }
      />
    );
    empty =
      searchEmpty ??
      (
        <button
          onClick={() => void a.pickFiles()}
          className="group flex w-full max-w-lg flex-col items-center rounded-3xl border-2 border-dashed border-white/15 px-8 py-10 text-center transition hover:border-accent/60 hover:bg-white/[0.03]"
        >
          <div className="neu-btn mb-4 grid h-16 w-16 shrink-0 place-items-center rounded-2xl transition group-hover:scale-105">
            <Upload className="h-7 w-7 text-accent" />
          </div>
          <p className="text-[15px] font-semibold">拖拽音乐文件到这里，或点击选择</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/50">{inTauri ? "支持多选音频文件，自动解析标签、内嵌封面与同名 LRC / SRT / TTML / ASS 歌词；导入后写入本机曲库并由 Rust 音频核心播放。" : "支持多选 .mp3 / .flac / .wav，自动解析 ID3 / Vorbis 标签、内嵌封面与同名 .lrc 歌词。导入的歌曲将安全保存在本机浏览器中。"}</p>
        </button>
      );
  } else if (s.nav === "recent") {
    header = (
      <ViewHeader
        art={<IconArt icon={Clock3} gradient="linear-gradient(135deg,#818cf8,#0ea5e9)" />}
        eyebrow="History"
        title="最近播放"
        desc={`最近播放过的 ${base.length} 首歌曲`}
        actions={
          base.length > 0 && (
            <>
              <PrimaryAction icon={Play} onClick={playAll}>播放全部</PrimaryAction>
              <PrimaryAction icon={Trash2} variant="neu" onClick={a.clearRecent}>清空记录</PrimaryAction>
            </>
          )
        }
      />
    );
    empty = searchEmpty ?? <Empty icon={Clock3} title="还没有播放记录" desc="开始播放任意歌曲，这里会自动记录你的聆听足迹。" />;
  } else if (s.nav === "liked") {
    header = (
      <ViewHeader
        art={<IconArt icon={Heart} gradient="linear-gradient(135deg,#fb7185,#a855f7)" />}
        eyebrow="Favorites"
        title="我喜欢的"
        desc={`${base.length} 首收藏 · ${totalDur}`}
        actions={base.length > 0 && <PrimaryAction icon={Play} onClick={playAll}>播放全部</PrimaryAction>}
      />
    );
    empty = searchEmpty ?? <Empty icon={Heart} title="还没有喜欢的歌曲" desc="点击歌曲旁的心形图标，或按下 L 键收藏正在播放的歌曲。" />;
  } else if (s.nav === "playlists") {
    header = playlist ? (
      <ViewHeader
        art={
          <div className="relative grid h-[100px] w-[100px] shrink-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-2xl shadow-[0_16px_36px_rgba(0,0,0,0.5)]" style={{ background: playlist.gradient }}>
            {base.slice(0, 4).map((t) => (
              <Cover key={t.id} src={t.cover} alt="" seed={t.id} className="h-full w-full" />
            ))}
          </div>
        }
        eyebrow="Curated Playlist"
        title={playlist.name}
        desc={`${playlist.desc} · ${base.length} 首`}
        actions={
          <>
            <PrimaryAction icon={Play} onClick={playAll}>播放全部</PrimaryAction>
            <PrimaryAction icon={ArrowLeft} variant="neu" onClick={() => a.openPlaylist(null)}>全部歌单</PrimaryAction>
          </>
        }
      />
    ) : (
      <ViewHeader
        art={<IconArt icon={Sparkles} gradient="linear-gradient(135deg,#f59e0b,#ec4899,#8b5cf6)" />}
        eyebrow="Curated"
        title="精选歌单"
        desc="根据曲风与情绪为你自动编排的歌单，随曲库实时更新"
      />
    );
    empty = searchEmpty ?? <Empty icon={Music2} title="歌单暂时为空" desc="导入更多本地音乐，歌单会自动收录匹配的歌曲。" />;
  }

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={viewKey}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3"
      >
        {header}
        {s.nav === "playlists" && !playlist ? (
          <PlaylistsGrid />
        ) : (
          <>
            <FilterBar source={source} setSource={setSource} sort={sort} setSort={setSort} count={list.length} showSource={s.nav === "library"} />
            <TrackTable tracks={list} emptyNode={empty} />
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
