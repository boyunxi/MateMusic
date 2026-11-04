const stages = [
  { id: "M0", label: "方案与文档", state: "done" },
  { id: "M1", label: "音频技术验证", state: "active" },
  { id: "M2", label: "可用播放器", state: "todo" },
  { id: "M3", label: "高级音频与歌词", state: "todo" },
  { id: "M4", label: "界面成品化", state: "todo" },
  { id: "M5", label: "验收与发布", state: "todo" },
] as const;

export default function App() {
  return (
    <div className="shell">
      <aside className="rail">
        <div className="wordmark">MateMusic</div>
        <nav className="rail-nav">
          <span className="nav-item">曲库</span>
          <span className="nav-item">播放</span>
          <span className="nav-item">歌单</span>
          <span className="nav-item">设置</span>
        </nav>
      </aside>

      <main className="stage">
        <header className="stage-head">
          <p className="eyebrow">M1 · 音频技术验证</p>
          <h1>解码链路先行，界面随后。</h1>
          <p className="lede">
            当前工程为脚手架：播放时钟、PCM 缓冲与 WASAPI 输出在 Rust 侧验证通过后，再接入界面。
          </p>
        </header>

        <ol className="milestones">
          {stages.map((stage) => (
            <li key={stage.id} className={`milestone is-${stage.state}`}>
              <span className="milestone-id">{stage.id}</span>
              <span className="milestone-label">{stage.label}</span>
            </li>
          ))}
        </ol>
      </main>
    </div>
  );
}
