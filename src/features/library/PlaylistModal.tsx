import { useCallback, useEffect, useState } from "react";
import { ListMusic, Plus, X } from "lucide-react";
import {
  addTrackToPlaylist,
  createPlaylist,
  getPlaylists,
} from "../../lib/library";
import type { LibraryTrack, PlaylistRow } from "../../lib/library";
import { useToastStore } from "../../store/useToastStore";

type Props = {
  track?: LibraryTrack;
  onClose: () => void;
  onChanged: () => void;
};

export default function PlaylistModal({ track, onClose, onChanged }: Props) {
  const pushToast = useToastStore((state) => state.push);
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPlaylists(await getPlaylists());
    } catch (err) {
      pushToast({ kind: "error", message: String(err) });
    }
  }, [pushToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const id = await createPlaylist(trimmed);
      if (track) {
        await addTrackToPlaylist(id, track.id);
        pushToast({ kind: "success", message: `已加入「${trimmed}」` });
        onChanged();
        onClose();
      } else {
        pushToast({ kind: "success", message: `已创建「${trimmed}」` });
        setName("");
        await load();
        onChanged();
      }
    } catch (err) {
      pushToast({ kind: "error", message: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const add = async (playlist: PlaylistRow) => {
    if (!track || busy) return;
    setBusy(true);
    try {
      const added = await addTrackToPlaylist(playlist.id, track.id);
      pushToast({
        kind: "success",
        message: added ? `已加入「${playlist.name}」` : `「${playlist.name}」里已有这首歌`,
      });
      onChanged();
      onClose();
    } catch (err) {
      pushToast({ kind: "error", message: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <h2>{track ? "加入歌单" : "新建歌单"}</h2>
          <button className="modal-close" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        {track && <p className="modal-track">{track.title}</p>}

        <div className="modal-create">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={track ? "新建歌单并加入" : "歌单名称"}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
            }}
            autoFocus
          />
          <button type="button" onClick={() => void create()} disabled={busy}>
            <Plus size={15} />
            {busy ? "处理中…" : "新建"}
          </button>
        </div>

        {track && (
          <div className="modal-list">
            {playlists.length === 0 ? (
              <p className="modal-empty">还没有歌单，先创建一个。</p>
            ) : (
              playlists.map((playlist) => (
                <button
                  key={playlist.id}
                  type="button"
                  onClick={() => void add(playlist)}
                >
                  <ListMusic size={15} />
                  <span>{playlist.name}</span>
                  <em>{playlist.trackCount}</em>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
