#[derive(Clone, Debug)]
pub struct CueTrack {
    pub number: u32,
    pub title: String,
    pub performer: Option<String>,
    pub start: f64,
    pub end: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct CueFile {
    pub file: String,
    pub album: Option<String>,
    pub performer: Option<String>,
    pub tracks: Vec<CueTrack>,
}

#[derive(Default)]
struct PendingTrack {
    number: u32,
    title: Option<String>,
    performer: Option<String>,
    start: Option<f64>,
}

fn quoted_value(value: &str) -> String {
    let value = value.trim();
    if value.starts_with('"') {
        if let Some(end) = value[1..].find('"') {
            return value[1..1 + end].to_string();
        }
    }
    value
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_matches('"')
        .to_string()
}

fn parse_index(value: &str) -> Option<f64> {
    let parts: Vec<&str> = value.trim().split(':').collect();
    match parts.as_slice() {
        [minutes, seconds] => {
            let minutes: f64 = minutes.parse().ok()?;
            let seconds: f64 = seconds.parse().ok()?;
            Some(minutes * 60.0 + seconds)
        }
        [minutes, seconds, frames] => {
            let minutes: f64 = minutes.parse().ok()?;
            let seconds: f64 = seconds.parse().ok()?;
            let frames: f64 = frames.parse().ok()?;
            Some(minutes * 60.0 + seconds + frames / 75.0)
        }
        _ => None,
    }
}

fn close_track(pending: &mut Vec<PendingTrack>, current: &mut Option<PendingTrack>) {
    if let Some(track) = current.take() {
        if track.start.is_some() {
            pending.push(track);
        }
    }
}

fn build_file(
    file: String,
    album: &Option<String>,
    performer: &Option<String>,
    pending: &mut Vec<PendingTrack>,
) -> Option<CueFile> {
    if file.is_empty() || pending.is_empty() {
        pending.clear();
        return None;
    }

    let mut tracks = Vec::new();
    let count = pending.len();
    for index in 0..count {
        let track = &pending[index];
        let start = track.start.unwrap_or(0.0);
        let end = pending.get(index + 1).map(|next| next.start.unwrap_or(start));
        tracks.push(CueTrack {
            number: track.number,
            title: track
                .title
                .clone()
                .unwrap_or_else(|| format!("Track {:02}", track.number)),
            performer: track.performer.clone(),
            start,
            end,
        });
    }
    pending.clear();

    Some(CueFile {
        file,
        album: album.clone(),
        performer: performer.clone(),
        tracks,
    })
}

pub fn parse_cue(text: &str) -> Vec<CueFile> {
    let mut files = Vec::new();
    let mut album_title = None;
    let mut album_performer = None;
    let mut current_file: Option<String> = None;
    let mut current_track: Option<PendingTrack> = None;
    let mut pending: Vec<PendingTrack> = Vec::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.to_ascii_uppercase().starts_with("REM ") {
            continue;
        }
        let (command, rest) = match line.split_once(char::is_whitespace) {
            Some((command, rest)) => (command.to_ascii_uppercase(), rest.trim()),
            None => (line.to_ascii_uppercase(), ""),
        };

        match command.as_str() {
            "FILE" => {
                close_track(&mut pending, &mut current_track);
                if let Some(file) = current_file.take() {
                    if let Some(group) =
                        build_file(file, &album_title, &album_performer, &mut pending)
                    {
                        files.push(group);
                    }
                }
                current_file = Some(quoted_value(rest));
            }
            "TRACK" => {
                close_track(&mut pending, &mut current_track);
                let number = rest
                    .split_whitespace()
                    .next()
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(0);
                current_track = Some(PendingTrack {
                    number,
                    ..Default::default()
                });
            }
            "TITLE" => {
                let value = quoted_value(rest);
                if let Some(track) = current_track.as_mut() {
                    track.title = Some(value);
                } else {
                    album_title = Some(value);
                }
            }
            "PERFORMER" => {
                let value = quoted_value(rest);
                if let Some(track) = current_track.as_mut() {
                    track.performer = Some(value);
                } else {
                    album_performer = Some(value);
                }
            }
            "INDEX" => {
                let mut parts = rest.split_whitespace();
                let index_number = parts.next();
                if index_number == Some("01") {
                    if let Some(track) = current_track.as_mut() {
                        if track.start.is_none() {
                            track.start = parts.next().and_then(parse_index);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    close_track(&mut pending, &mut current_track);
    if let Some(file) = current_file.take() {
        if let Some(group) = build_file(file, &album_title, &album_performer, &mut pending) {
            files.push(group);
        }
    }

    files
}
