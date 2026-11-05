import { create } from "zustand";
import { loadTrack, pauseTrack } from "../lib/player";
import type { LibraryTrack } from "../lib/library";

export type View = "library" | "now" | "lyrics" | "settings";
export type PlayMode = "sequential" | "repeat-all" | "repeat-one" | "shuffle";

type AppState = {
  view: View;
  queue: LibraryTrack[];
  currentIndex: number;
  mode: PlayMode;
  setView: (view: View) => void;
  setMode: (mode: PlayMode) => void;
  restore: (queue: LibraryTrack[], currentIndex: number, mode: PlayMode) => void;
  playTrack: (track: LibraryTrack, list?: LibraryTrack[]) => void;
  playIndex: (index: number) => void;
  syncCurrent: (path: string, segmentStart: number) => void;
  enqueue: (track: LibraryTrack) => void;
  removeAt: (index: number) => void;
  move: (from: number, to: number) => void;
  next: (auto?: boolean) => void;
  prev: () => void;
  clearQueue: () => void;
};

export const useAppStore = create<AppState>((set, get) => {
  const playAt = (queue: LibraryTrack[], index: number) => {
    const track = queue[index];
    if (!track) return;
    set({ queue, currentIndex: index, view: "now" });
    void loadTrack(track.path, track.cueStart ?? null, track.cueEnd ?? null);
  };

  return {
    view: "now",
    queue: [],
    currentIndex: -1,
    mode: "sequential",

    setView: (view) => set({ view }),
    setMode: (mode) => set({ mode }),
    restore: (queue, currentIndex, mode) => set({ queue, currentIndex, mode }),

    playTrack: (track, list) => {
      const state = get();
      let queue = list && list.length ? [...list] : [...state.queue];
      let index = queue.findIndex((item) => item.id === track.id);
      if (index < 0) {
        queue.push(track);
        index = queue.length - 1;
      }
      playAt(queue, index);
    },

    playIndex: (index) => {
      const queue = get().queue;
      if (index >= 0 && index < queue.length) playAt(queue, index);
    },

    syncCurrent: (path, segmentStart) => {
      const { queue } = get();
      const index = queue.findIndex(
        (track) =>
          track.path === path &&
          Math.abs((track.cueStart ?? 0) - segmentStart) < 0.05,
      );
      if (index >= 0) set({ currentIndex: index });
    },

    enqueue: (track) => {
      const queue = get().queue;
      if (queue.some((item) => item.id === track.id)) return;
      set({ queue: [...queue, track] });
    },

    removeAt: (index) => {
      const state = get();
      const queue = state.queue.filter((_, i) => i !== index);
      let currentIndex = state.currentIndex;
      if (index < currentIndex) currentIndex -= 1;
      if (currentIndex >= queue.length) currentIndex = queue.length - 1;
      set({ queue, currentIndex });
    },

    move: (from, to) => {
      const state = get();
      if (from === to || from < 0 || to < 0) return;
      const queue = [...state.queue];
      if (from >= queue.length || to >= queue.length) return;
      const [item] = queue.splice(from, 1);
      queue.splice(to, 0, item);
      let currentIndex = state.currentIndex;
      if (currentIndex === from) currentIndex = to;
      else if (from < currentIndex && to >= currentIndex) currentIndex -= 1;
      else if (from > currentIndex && to <= currentIndex) currentIndex += 1;
      set({ queue, currentIndex });
    },

    next: (auto = false) => {
      const { queue, currentIndex, mode } = get();
      if (!queue.length) return;
      let index = currentIndex;
      if (mode === "repeat-one" && auto) {
        index = currentIndex;
      } else if (mode === "shuffle") {
        index =
          queue.length === 1
            ? 0
            : (currentIndex + 1 + Math.floor(Math.random() * (queue.length - 1))) %
              queue.length;
      } else if (currentIndex + 1 < queue.length) {
        index = currentIndex + 1;
      } else if (mode === "repeat-all") {
        index = 0;
      } else if (auto) {
        void pauseTrack();
        return;
      }
      playAt(queue, Math.max(0, index));
    },

    prev: () => {
      const { queue, currentIndex, mode } = get();
      if (!queue.length) return;
      let index = currentIndex;
      if (currentIndex > 0) index = currentIndex - 1;
      else if (mode === "repeat-all") index = queue.length - 1;
      playAt(queue, Math.max(0, index));
    },

    clearQueue: () => set({ queue: [], currentIndex: -1 }),
  };
});
