import { PlayerProvider, useActions, usePlayer } from "./store/PlayerStore";
import { AmbientBackground, Sidebar, TitleBar } from "./components/Shell";
import { LibraryView } from "./components/LibraryView";
import { Dock, FloatingLyrics } from "./components/Dock";
import { QueueDrawer } from "./components/QueueDrawer";
import { ImmersivePlayer } from "./components/ImmersivePlayer";
import { SettingsWindow } from "./components/SettingsWindow";
import { DropOverlay, ImportProgress, MiniPlayer, SleepScreen, Toasts, useDropImport, useShortcuts } from "./components/Overlays";

function MateMusicShell() {
  const s = usePlayer();
  const a = useActions();
  const dragging = useDropImport();
  useShortcuts();

  return (
    <div className="relative flex h-screen w-screen min-h-[640px] min-w-[960px] select-none flex-col overflow-hidden text-white">
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
