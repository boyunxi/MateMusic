import { useEffect } from "react";
import { PlayerProvider, useActions, usePlayer } from "./store/PlayerStore";
import { AmbientBackground, ResizeHandles, Sidebar, TitleBar } from "./components/Shell";
import { LibraryView } from "./components/LibraryView";
import { Dock, FloatingLyrics } from "./components/Dock";
import { QueueDrawer } from "./components/QueueDrawer";
import { ImmersivePlayer } from "./components/ImmersivePlayer";
import { SettingsWindow } from "./components/SettingsWindow";
import { DropOverlay, ImportProgress, MiniPlayer, SleepScreen, Toasts, useDropImport, useShortcuts } from "./components/Overlays";
import { cn } from "./utils/cn";
import { ensureNormalWindow } from "./lib/windowBounds";

function MateMusicShell() {
  const s = usePlayer();
  const a = useActions();
  const dragging = useDropImport();
  useShortcuts();

  useEffect(() => {
    void ensureNormalWindow();
  }, []);

  return (
    <div
      className={cn(
        "relative flex h-screen w-screen select-none flex-col overflow-hidden text-white",
        s.windowMode === "normal" && "min-h-[640px] min-w-[960px]",
      )}
    >
      <input
        id="mm-file-input"
        type="file"
        multiple
        accept=".mp3,.flac,.wav,.m4a,.aac,.ogg,.opus,.lrc,audio/*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void a.importFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {s.windowMode === "mini" ? (
        <MiniPlayer />
      ) : s.windowMode === "sleep" ? (
        <SleepScreen />
      ) : (
        <>
          <AmbientBackground />
          <TitleBar />
          <div className="relative flex min-h-0 flex-1 gap-3 px-4 pb-3 pt-1">
            <Sidebar />
            <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
              <LibraryView />
              <QueueDrawer />
            </main>
          </div>
          <FloatingLyrics />
          <Dock />
          <ImmersivePlayer />
          <SettingsWindow />
        </>
      )}

      <ImportProgress />
      <Toasts />
      <DropOverlay show={dragging} />
      {s.windowMode === "normal" && <ResizeHandles />}
    </div>
  );
}

export default function App() {
  return (
    <PlayerProvider>
      <MateMusicShell />
    </PlayerProvider>
  );
}
