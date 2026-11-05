import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  Disc3,
  FolderOpen,
  ListMusic,
  ListPlus,
  Music2,
  Play,
  Plus,
  Search,
  UserRound,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { formatTime, formatTrackFormat } from "../../lib/format";
import {
  coverArtClass,
  coverUrl,
  getAlbums,
  getArtists,
  getAlbumTracks,
  getArtistTracks,
  getFolders,
  getPlaylists,
  getPlaylistTracks,
  getStats,
  getTracks,
  importFolder,
  subscribeLibraryChanged,
} from "../../lib/library";
import type {
  AlbumRow,
  ArtistRow,
  FolderRow,
  LibraryStats,
  LibraryTrack,
  PlaylistRow,
} from "../../lib/library";
import { inTauri } from "../../lib/player";
import { useAppStore } from "../../store/useAppStore";
import { useToastStore } from "../../store/useToastStore";
import PlaylistModal from "./PlaylistModal";

const SORTS = [
  { id: "title", label: "标题" },
  { id: "artist", label: "艺术家" },
  { id: "album", label: "专辑" },
  { id: "recent", label: "最近" },
];

const ALBUM_SORTS = [
  { id: "album", label: "专辑" },
  { id: "artist", label: "艺术家" },
  { id: "year", label: "年份" },
];

const ARTIST_SORTS = [
  { id: "artist", label: "名称" },
  { id: "albums", label: "专辑数" },
  { id: "tracks", label: "曲目数" },
];

const PAGE_SIZE = 200;
const COLLECTION_PAGE = 1000;

type Mode = "songs" | "albums" | "artists";

type Collection =
  | { type: "album"; album: AlbumRow }
  | { type: "artist"; artist: ArtistRow };

function stringHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export default function LibraryView() {
  const [mode, setMode] = useState<Mode>("songs");
  const [collection, setCollection] = useState<Collection | null>(null);
  const [collectionTracks, setCollectionTracks] = useState<LibraryTrack[]>([]);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [albums, setAlbums] = useState<AlbumRow[]>([]);
  const [albumTotal, setAlbumTotal] = useState(0);
  const [artists, setArtists] = useState<ArtistRow[]>([]);
  const [artistTotal, setArtistTotal] = useState(0);
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  const [playlistId, setPlaylistId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("title");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [modal, setModal] = useState<{ track?: LibraryTrack } | null>(null);

  const pushToast = useToastStore((state) => state.push);
  const playTrack = useAppStore((state) => state.playTrack);
  const enqueue = useAppStore((state) => state.enqueue);
  const currentId = useAppStore((state) => state.queue[state.currentIndex]?.id ?? null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);

  const refreshMeta = useCallback(async () => {
    const [statsData, folderData, playlistData] = await Promise.all([
      getStats(),
      getFolders(),
      getPlaylists(),
    ]);
    setStats(statsData);
    setFolders(folderData);
    setPlaylists(playlistData);
  }, []);

  const loadCollection = useCallback(
    async (target: Collection) => {
      setCollectionLoading(true);
      try {
        const page =
          target.type === "album"
            ? await getAlbumTracks(
                target.album.album,
                target.album.albumArtist,
                COLLECTION_PAGE,
                0,
              )
            : await getArtistTracks(target.artist.artist, COLLECTION_PAGE, 0);
        setCollectionTracks(page.tracks);
        setTotal(page.total);
      } catch (error) {
        pushToast({ kind: "error", message: String(error), duration: 6000 });
        setCollectionTracks([]);
      } finally {
        setCollectionLoading(false);
      }
    },
    [pushToast],
  );

  const refresh = useCallback(async () => {
    if (!inTauri) return;
    try {
      await refreshMeta();
      if (collection) {
        await loadCollection(collection);
        return;
      }
      if (mode === "songs") {
        if (playlistId != null) {
          const playlistTracks = await getPlaylistTracks(playlistId);
          setTracks(playlistTracks);
          setTotal(playlistTracks.length);
        } else {
          const page = await getTracks({
            search: search.trim() || null,
            sort,
            limit: PAGE_SIZE,
            offset: 0,
          });
          setTracks(page.tracks);
          setTotal(page.total);
        }
        return;
      }
      if (mode === "albums") {
        const page = await getAlbums({
          search: search.trim() || null,
          sort,
          limit: PAGE_SIZE,
          offset: 0,
        });
        setAlbums(page.albums);
        setAlbumTotal(page.total);
        return;
      }
      const page = await getArtists({
        search: search.trim() || null,
        sort,
        limit: PAGE_SIZE,
        offset: 0,
      });
      setArtists(page.artists);
      setArtistTotal(page.total);
    } catch (error) {
      pushToast({ kind: "error", message: String(error) });
    }
  }, [collection, loadCollection, mode, playlistId, pushToast, refreshMeta, search, sort]);

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 180);
    return () => clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!inTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeLibraryChanged(() => void refresh()).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!inTauri || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      if (collection) {
        if (collectionTracks.length >= total) return;
        const offset = collectionTracks.length;
        const page =
          collection.type === "album"
            ? await getAlbumTracks(
                collection.album.album,
                collection.album.albumArtist,
                COLLECTION_PAGE,
                offset,
              )
            : await getArtistTracks(collection.artist.artist, COLLECTION_PAGE, offset);
        setCollectionTracks((previous) => [...previous, ...page.tracks]);
        setTotal(page.total);
        return;
      }
      if (mode === "songs") {
        if (playlistId != null || tracks.length >= total) return;
        const page = await getTracks({
          search: search.trim() || null,
          sort,
          limit: PAGE_SIZE,
          offset: tracks.length,
        });
        setTracks((previous) => [...previous, ...page.tracks]);
        setTotal(page.total);
        return;
      }
      if (mode === "albums") {
        if (albums.length >= albumTotal) return;
        const page = await getAlbums({
          search: search.trim() || null,
          sort,
          limit: PAGE_SIZE,
          offset: albums.length,
        });
        setAlbums((previous) => [...previous, ...page.albums]);
        setAlbumTotal(page.total);
        return;
      }
      if (artists.length >= artistTotal) return;
      const page = await getArtists({
        search: search.trim() || null,
        sort,
        limit: PAGE_SIZE,
        offset: artists.length,
      });
      setArtists((previous) => [...previous, ...page.artists]);
      setArtistTotal(page.total);
    } catch (error) {
      pushToast({ kind: "error", message: String(error), duration: 6000 });
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [
    albumTotal,
    albums.length,
    artistTotal,
    artists.length,
    collection,
    collectionTracks.length,
    mode,
    playlistId,
    pushToast,
    search,
    sort,
    total,
    tracks.length,
  ]);

  const displayTracks = useMemo(() => {
    if (collection) return collectionTracks;
    if (mode !== "songs") return [];
    if (playlistId == null) return tracks;
    const query = search.trim().toLowerCase();
    const filtered = tracks.filter(
      (track) =>
        !query ||
        [track.title, track.artist, track.album].some((value) =>
          value?.toLowerCase().includes(query),
        ),
    );
    const sorted = [...filtered];
    const compare = (a: string | null, b: string | null) =>
      (a ?? "").localeCompare(b ?? "", "zh-Hans-CN");
    switch (sort) {
      case "artist":
        sorted.sort(
          (a, b) => compare(a.artist, b.artist) || compare(a.album, b.album),
        );
        break;
      case "album":
        sorted.sort(
          (a, b) =>
            compare(a.album, b.album) ||
            (a.discNo ?? 0) - (b.discNo ?? 0) ||
            (a.trackNo ?? 0) - (b.trackNo ?? 0),
        );
        break;
      case "duration":
        sorted.sort((a, b) => b.duration - a.duration);
        break;
      case "recent":
        break;
      default:
        sorted.sort((a, b) => compare(a.title, b.title));
    }
    return sorted;
  }, [collection, collectionTracks, mode, playlistId, search, sort, tracks]);

  const virtualizer = useVirtualizer({
    count: displayTracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 54,
    overscan: 8,
  });

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 360) {
      void loadMore();
    }
  };

  const handleImport = async () => {
    if (!inTauri) return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择音乐文件夹",
      });
      if (typeof selected !== "string") return;
      setBusy(true);
      await importFolder(selected);
      pushToast({ kind: "info", message: "已开始扫描文件夹", duration: 3000 });
      await refresh();
    } catch (error) {
      pushToast({ kind: "error", message: String(error), duration: 6000 });
    } finally {
      setBusy(false);
    }
  };

  const changeMode = (next: Mode) => {
    if (next === mode && !collection) return;
    setCollection(null);
    setPlaylistId(null);
    setSearch("");
    setMode(next);
    setSort(next === "songs" ? "title" : next === "albums" ? "album" : "artist");
  };

  const activePlaylist = playlists.find((playlist) => playlist.id === playlistId) ?? null;
  const virtualItems = virtualizer.getVirtualItems();
  const sortOptions =
    mode === "songs" ? SORTS : mode === "albums" ? ALBUM_SORTS : ARTIST_SORTS;
  const collectionTitle = collection
    ? collection.type === "album"
      ? collection.album.album
      : collection.artist.artist
    : "";
  const collectionSubtitle = collection
    ? collection.type === "album"
      ? `${collection.album.albumArtist ?? collection.album.artist ?? "未知艺术家"} · ${
          collection.album.year ?? "年份未知"
        } · ${collection.album.trackCount} 首`
      : `${collection.artist.albumCount} 张专辑 · ${collection.artist.trackCount} 首`
    : "";
  const collectionCover = collection
    ? coverUrl(
        collection.type === "album"
          ? collection.album.coverPath
          : collection.artist.coverPath,
      )
    : null;
  const collectionSeed = stringHash(collectionTitle);
  const listTracks = collection ? collectionTracks : mode === "songs" ? displayTracks : [];
  const emptySongs = listTracks.length === 0;

  const renderTrackRows = (list: LibraryTrack[]) => (
    <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualItems.map((virtualRow) => {
        const track = list[virtualRow.index];
        if (!track) return null;
        const cover = coverUrl(track.coverPath);
        return (
          <div
            key={track.id}
            className={`track-row ${currentId === track.id ? "is-current" : ""}`}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: virtualRow.size,
              transform: `translateY(${virtualRow.start}px)`,
            }}
            onDoubleClick={() => playTrack(track, list)}
          >
            <span className={`track-cover ${coverArtClass(track.id)}`}>
              {cover && <img src={cover} alt="" loading="lazy" />}
            </span>
            <span className="track-main">
              <strong>{track.title}</strong>
              <em>{track.artist ?? "未知艺术家"}</em>
            </span>
            <span className="track-album">{track.album ?? "—"}</span>
            <span className="track-format">
              {formatTrackFormat(track.codec, track.bits, track.sampleRate)}
            </span>
            <span className="track-duration">{formatTime(track.duration)}</span>
            <span className="track-actions">
              <button
                type="button"
                onClick={() => playTrack(track, list)}
                aria-label={`播放 ${track.title}`}
              >
                <Play size={15} fill="currentColor" />
              </button>
              <button
                type="button"
                onClick={() => enqueue(track)}
                aria-label={`将 ${track.title} 加入队列`}
              >
                <ListPlus size={15} />
              </button>
              <button
                type="button"
                onClick={() => setModal({ track })}
                aria-label={`将 ${track.title} 加入歌单`}
              >
                <ListMusic size={15} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="library-view">
      {collection ? (
        <header className="library-head collection-head">
          <div className="collection-head-main">
            <button
              type="button"
              className="library-back"
              onClick={() => setCollection(null)}
            >
              <ArrowLeft size={15} /> 返回
            </button>
            <span className={`collection-cover ${coverArtClass(collectionSeed)}`}>
              {collectionCover && <img src={collectionCover} alt="" />}
            </span>
            <div>
              <p className="eyebrow">{collection.type === "album" ? "专辑" : "艺术家"}</p>
              <h1>{collectionTitle}</h1>
              <p className="library-stats">{collectionSubtitle}</p>
            </div>
          </div>
          <button
            className="import-button"
            type="button"
            onClick={() => {
              if (collectionTracks.length > 0) {
                playTrack(collectionTracks[0], collectionTracks);
              }
            }}
            disabled={collectionTracks.length === 0}
          >
            <Play size={15} fill="currentColor" /> 播放全部
          </button>
        </header>
      ) : (
        <header className="library-head">
          <div>
            <p className="eyebrow">曲库</p>
            <h1>{activePlaylist?.name ?? "本地音乐"}</h1>
            <p className="library-stats">
              {activePlaylist
                ? `${displayTracks.length} 首 · 歌单`
                : stats
                  ? `${stats.tracks} 首 · ${stats.albums} 张专辑 · ${stats.artists} 位艺术家`
                  : "尚未导入音乐"}
            </p>
          </div>
          <button
            className="import-button"
            type="button"
            onClick={handleImport}
            disabled={busy}
          >
            <FolderOpen size={16} />
            {busy ? "读取中…" : "导入文件夹"}
          </button>
        </header>
      )}

      {!collection && (
        <>
          <div className="library-toolbar">
            <label className="search-box">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={
                  mode === "songs"
                    ? "搜索标题、艺术家、专辑"
                    : mode === "albums"
                      ? "搜索专辑、艺术家"
                      : "搜索艺术家、专辑"
                }
                aria-label="搜索曲库"
              />
              {search && (
                <button
                  type="button"
                  className="search-clear"
                  onClick={() => setSearch("")}
                  aria-label="清空搜索"
                >
                  <X size={14} />
                </button>
              )}
            </label>
            <div className="library-mode-tabs" role="group" aria-label="曲库视图">
              <button
                type="button"
                className={mode === "songs" ? "is-active" : ""}
                onClick={() => changeMode("songs")}
              >
                <Music2 size={13} /> 歌曲
              </button>
              <button
                type="button"
                className={mode === "albums" ? "is-active" : ""}
                onClick={() => changeMode("albums")}
              >
                <Disc3 size={13} /> 专辑
              </button>
              <button
                type="button"
                className={mode === "artists" ? "is-active" : ""}
                onClick={() => changeMode("artists")}
              >
                <UserRound size={13} /> 艺术家
              </button>
            </div>
            <div className="sort-tabs" role="group" aria-label="排序">
              {sortOptions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={sort === item.id ? "is-active" : ""}
                  onClick={() => setSort(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {mode === "songs" && (
            <div className="playlist-bar">
              <button
                type="button"
                className={`playlist-chip ${playlistId == null ? "is-active" : ""}`}
                onClick={() => setPlaylistId(null)}
              >
                全部曲目
              </button>
              {playlists.map((playlist) => (
                <button
                  key={playlist.id}
                  type="button"
                  className={`playlist-chip ${playlistId === playlist.id ? "is-active" : ""}`}
                  onClick={() => setPlaylistId(playlist.id)}
                >
                  {playlist.name}
                  <em>{playlist.trackCount}</em>
                </button>
              ))}
              <button
                type="button"
                className="playlist-chip playlist-create"
                onClick={() => setModal({})}
              >
                <Plus size={13} />
                新建歌单
              </button>
            </div>
          )}
        </>
      )}

      <div ref={scrollRef} className="library-scroll" onScroll={handleScroll}>
        {collection ? (
          collectionLoading && collectionTracks.length === 0 ? (
            <div className="library-empty">
              <Music2 size={28} strokeWidth={1.4} />
              <p>正在读取曲目…</p>
            </div>
          ) : emptySongs ? (
            <div className="library-empty">
              <Music2 size={28} strokeWidth={1.4} />
              <p>这个收藏还没有曲目</p>
            </div>
          ) : (
            <>
              {renderTrackRows(collectionTracks)}
              {collectionTracks.length < total && (
                <button
                  className="load-more"
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? "读取中…" : `加载更多（${collectionTracks.length}/${total}）`}
                </button>
              )}
            </>
          )
        ) : mode === "songs" ? (
          emptySongs ? (
            <div className="library-empty">
              <Music2 size={28} strokeWidth={1.4} />
              <p>{playlistId != null ? "这个歌单还是空的" : "曲库还是空的"}</p>
              <p>
                {playlistId != null
                  ? "在全部曲目里点「加入歌单」，把歌曲放进来。"
                  : "导入一个本地音乐文件夹，MateMusic 会在后台建立索引。"}
              </p>
              {playlistId == null && (
                <button type="button" onClick={handleImport} disabled={busy}>
                  <FolderOpen size={15} /> 选择文件夹
                </button>
              )}
            </div>
          ) : (
            <>
              {renderTrackRows(displayTracks)}
              {playlistId == null && tracks.length < total && (
                <button
                  className="load-more"
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? "读取中…" : `加载更多（${tracks.length}/${total}）`}
                </button>
              )}
            </>
          )
        ) : mode === "albums" ? (
          albums.length === 0 ? (
            <div className="library-empty">
              <Disc3 size={28} strokeWidth={1.4} />
              <p>还没有专辑信息</p>
              <p>导入带专辑标签的音乐后，这里会按专辑聚合。</p>
            </div>
          ) : (
            <>
              <div className="album-grid">
                {albums.map((album) => {
                  const cover = coverUrl(album.coverPath);
                  const seed = stringHash(`${album.album}-${album.albumArtist ?? ""}`);
                  return (
                    <button
                      key={`${album.album}-${album.albumArtist ?? ""}`}
                      type="button"
                      className="album-card"
                      onClick={() => {
                        setCollection({ type: "album", album });
                        setCollectionLoading(true);
                      }}
                    >
                      <span className={`album-art ${coverArtClass(seed)}`}>
                        {cover && <img src={cover} alt="" loading="lazy" />}
                      </span>
                      <strong>{album.album}</strong>
                      <em>{album.albumArtist ?? album.artist ?? "未知艺术家"}</em>
                      <span className="album-meta">
                        {album.year ?? "年份未知"} · {album.trackCount} 首
                      </span>
                    </button>
                  );
                })}
              </div>
              {albums.length < albumTotal && (
                <button
                  className="load-more"
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? "读取中…" : `加载更多（${albums.length}/${albumTotal}）`}
                </button>
              )}
            </>
          )
        ) : artists.length === 0 ? (
          <div className="library-empty">
            <UserRound size={28} strokeWidth={1.4} />
            <p>还没有艺术家信息</p>
            <p>导入带艺术家标签的音乐后，这里会按艺术家聚合。</p>
          </div>
        ) : (
          <>
            <div className="artist-grid">
              {artists.map((artist) => {
                const cover = coverUrl(artist.coverPath);
                const seed = stringHash(artist.artist);
                return (
                  <button
                    key={artist.artist}
                    type="button"
                    className="artist-card"
                    onClick={() => {
                      setCollection({ type: "artist", artist });
                      setCollectionLoading(true);
                    }}
                  >
                    <span className={`artist-avatar ${coverArtClass(seed)}`}>
                      {cover && <img src={cover} alt="" loading="lazy" />}
                    </span>
                    <strong>{artist.artist}</strong>
                    <em>
                      {artist.albumCount} 张专辑 · {artist.trackCount} 首
                    </em>
                  </button>
                );
              })}
            </div>
            {artists.length < artistTotal && (
              <button
                className="load-more"
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "读取中…" : `加载更多（${artists.length}/${artistTotal}）`}
              </button>
            )}
          </>
        )}
      </div>

      <footer className="library-foot">
        {collection
          ? `显示 ${collectionTracks.length} / ${total} 首 · ${collectionTitle}`
          : mode === "albums"
            ? `显示 ${albums.length} / ${albumTotal} 张专辑`
            : mode === "artists"
              ? `显示 ${artists.length} / ${artistTotal} 位艺术家`
              : `显示 ${displayTracks.length} / ${total} 首`}
        {!collection && folders.length > 0 ? ` · ${folders.length} 个目录` : ""}
        {!collection && activePlaylist ? ` · 歌单「${activePlaylist.name}」` : ""}
      </footer>

      {modal && (
        <PlaylistModal
          track={modal.track}
          onClose={() => setModal(null)}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
