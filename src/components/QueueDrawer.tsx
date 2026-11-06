import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
import { GripVertical, ListX, Repeat, Repeat1, Shuffle, X } from "lucide-react";
import type { Track } from "../types";
import { useActions, usePlayer, useTrackLookup } from "../store/PlayerStore";
import { formatTime } from "../lib/utils";
import { cn } from "../utils/cn";
import { Bars, Cover, SPRING } from "./ui";

function QueueItem({ t, index, current }: { t: Track; index: number; current: boolean }) {
  const s = usePlayer();
  const a = useActions();
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={t.id}
      dragListener={false}
      dragControls={controls}
      layout="position"
      transition={SPRING}
      whileDrag={{ scale: 1.02, boxShadow: "0 18px 40px rgba(0,0,0,0.5)", zIndex: 5 }}
      className={cn(
        "group relative flex h-14 shrink-0 items-center gap-2.5 rounded-xl border border-transparent pl-1 pr-2 transition-colors",
        current ? "border-white/10 bg-white/[0.09]" : "hover:bg-white/[0.06]",
      )}
      onDoubleClick={() => a.playTrack(t.id)}
    >
      <span
        onPointerDown={(e) => controls.start(e)}
        className="grid h-10 w-6 shrink-0 cursor-grab touch-none place-items-center text-white/25 hover:text-white/70 active:cursor-grabbing"
        title="拖拽排序"
      >
        <GripVertical className="h-4 w-4" />
      </span>
      <button onClick={() => a.playTrack(t.id)} className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg" aria-label="播放">
        <Cover src={t.cover} alt="" seed={t.id} className="h-10 w-10" />
        {current && (
          <span className="absolute inset-0 grid place-items-center bg-black/45">
            <Bars playing={s.isPlaying} />
          </span>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-[13px] font-medium", current ? "text-accent" : "text-white/90")}>{t.title}</span>
        <span className="truncate text-[11.5px] text-white/45">{t.artist}</span>
      </div>
      <span className="w-10 shrink-0 text-right text-[11.5px] tabular-nums text-white/40 group-hover:hidden">{formatTime(t.duration)}</span>
      <button
        onClick={() => a.removeFromQueue(t.id)}
        className="hidden h-7 w-7 shrink-0 place-items-center rounded-full text-white/50 hover:bg-white/10 hover:text-white group-hover:grid"
        aria-label="移出队列"
        title="移出队列"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <span className="sr-only">{index + 1}</span>
    </Reorder.Item>
  );
}

export function QueueDrawer() {
  const s = usePlayer();
  const a = useActions();
  const lookup = useTrackLookup();
  const items = lookup(s.queue);
  const ids = items.map((t) => t.id);
  const total = items.reduce((x, t) => x + (t.duration || 0), 0);
  const modeIcon = s.loopMode === "one" ? Repeat1 : s.loopMode === "shuffle" ? Shuffle : Repeat;
  const ModeIcon = modeIcon;

  return (
    <AnimatePresence>
      {s.queueOpen && (
        <>
          <motion.div
            key="queue-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => a.setQueueOpen(false)}
            className="absolute inset-0 z-30 bg-black/20"
          />
          <motion.aside
            key="queue"
            initial={{ x: 400, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 400, opacity: 0 }}
            transition={SPRING}
            className="glass-strong absolute bottom-0 right-0 top-0 z-40 flex w-[370px] min-h-0 flex-col overflow-hidden rounded-[22px]"
          >
            <div className="flex h-16 shrink-0 items-center gap-3 border-b border-white/[0.08] px-5">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[16px] font-semibold">播放队列</span>
                <span className="flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-white/45">
                  <ModeIcon className="h-3 w-3 shrink-0" />
                  <span className="truncate tabular-nums">
                    {s.loopMode === "one" ? "单曲循环" : s.loopMode === "shuffle" ? "随机播放" : "列表循环"} · {items.length} 首 · {formatTime(total)}
                  </span>
                </span>
              </div>
              <button
                onClick={a.clearQueue}
                className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white active:scale-95"
              >
                <ListX className="h-3.5 w-3.5" />
                清空
              </button>
              <button onClick={() => a.setQueueOpen(false)} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white active:scale-95" aria-label="关闭队列">
                <X className="h-4 w-4" />
              </button>
            </div>
            {items.length === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-[13px] text-white/45">队列为空，双击任意歌曲开始播放</div>
            ) : (
              <Reorder.Group axis="y" values={ids} onReorder={a.reorderQueue} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden p-2.5">
                {items.map((t, i) => (
                  <QueueItem key={t.id} t={t} index={i} current={t.id === s.currentId} />
                ))}
              </Reorder.Group>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
