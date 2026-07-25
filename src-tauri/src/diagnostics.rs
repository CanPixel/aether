//! A local diagnostics log the user can read and export.
//!
//! ÆTHER ships CPU-only Windows and Linux builds that are never run before
//! release, and it collects no telemetry — so without this, a failure on those
//! platforms produces a line on a stderr nobody will ever see. The point is a
//! feedback loop that costs the privacy promise nothing: the log is written only
//! to the user's own machine, is visible in Settings, and leaves it only when the
//! user presses Export.
//!
//! What is deliberately not recorded: page text, captured content, search queries,
//! and answers. Entries are operational — what failed and where — so an exported
//! log cannot become an accidental transcript of what someone was reading.

use super::*;
use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::OnceLock;

/// Kept in memory so Settings can show recent entries without reading the file
/// back. Bounded because a tight failure loop must not grow the process.
const MAX_ENTRIES: usize = 400;
/// The on-disk log is truncated to the newest half once it passes this. A log that
/// grows without limit is a bug report nobody can attach.
const MAX_LOG_BYTES: u64 = 512 * 1024;

pub(crate) const DIAGNOSTICS_DIR: &str = "aether-diagnostics";
pub(crate) const DIAGNOSTICS_FILE: &str = "aether.log";

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DiagnosticLevel {
    Info,
    Warn,
    Error,
}

impl DiagnosticLevel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticEntry {
    pub(crate) at: String,
    pub(crate) level: DiagnosticLevel,
    pub(crate) message: String,
}

fn buffer() -> &'static Mutex<VecDeque<DiagnosticEntry>> {
    static BUFFER: OnceLock<Mutex<VecDeque<DiagnosticEntry>>> = OnceLock::new();
    BUFFER.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_ENTRIES)))
}

// Set once during setup. Held separately from Backend because the first entries
// can be recorded while the app state is still being built — session restore runs
// before anything else and is one of the paths most worth logging.
fn log_path() -> &'static OnceLock<PathBuf> {
    static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
    &LOG_PATH
}

pub(crate) fn set_log_path(app_data_dir: &Path) {
    let _ = log_path().set(app_data_dir.join(DIAGNOSTICS_DIR).join(DIAGNOSTICS_FILE));
}

pub(crate) fn record(level: DiagnosticLevel, message: impl Into<String>) {
    let message = message.into();
    let entry = DiagnosticEntry {
        at: now(),
        level,
        message,
    };

    // Still goes to stderr: `tauri dev` and a terminal launch are where this is
    // most useful, and losing that would be a downgrade. Must stay a raw
    // eprintln! — routing it through a diag_* macro recurses into this function.
    eprintln!("aether [{}] {}", level.as_str(), entry.message);

    if let Ok(mut entries) = buffer().lock() {
        if entries.len() == MAX_ENTRIES {
            entries.pop_front();
        }
        entries.push_back(entry.clone());
    }

    append_to_file(&entry);
}

// Synchronous and best-effort by design. These are rare (failures, migrations),
// and a diagnostics write must never be able to fail an operation or block on an
// async runtime that may not exist on the calling thread.
fn append_to_file(entry: &DiagnosticEntry) {
    let Some(path) = log_path().get() else {
        return;
    };
    write_entry(path, entry);
}

// Split from append_to_file so the rollover and formatting can be tested without
// the process-wide OnceLock, which only one test could ever claim.
pub(crate) fn write_entry(path: &Path, entry: &DiagnosticEntry) {
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }

    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > MAX_LOG_BYTES {
            truncate_to_newest_half(path);
        }
    }

    let mut line = String::new();
    let _ = writeln!(
        line,
        "{} [{}] {}",
        entry.at,
        entry.level.as_str(),
        entry.message
    );

    use std::io::Write as _;
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

// Drops the oldest half rather than the whole file: a wrapping log that discards
// everything on rollover tends to be empty exactly when someone needs it.
fn truncate_to_newest_half(path: &Path) {
    let Ok(existing) = fs::read_to_string(path) else {
        return;
    };
    let lines: Vec<&str> = existing.lines().collect();
    let keep = lines.split_at(lines.len() / 2).1.join("\n");
    let _ = fs::write(path, format!("{keep}\n"));
}

pub(crate) fn recent() -> Vec<DiagnosticEntry> {
    buffer()
        .lock()
        .map(|entries| entries.iter().rev().cloned().collect())
        .unwrap_or_default()
}

pub(crate) fn diagnostics_log_path() -> Option<PathBuf> {
    log_path().get().cloned()
}

/// Records at warn level. Replaces the bare `eprintln!` calls that used to go to a
/// stderr nobody reads.
macro_rules! diag_warn {
    ($($arg:tt)*) => {
        crate::diagnostics::record(
            crate::diagnostics::DiagnosticLevel::Warn,
            format!($($arg)*),
        )
    };
}

/// Records at error level: something the user's library or a core action depends on.
macro_rules! diag_error {
    ($($arg:tt)*) => {
        crate::diagnostics::record(
            crate::diagnostics::DiagnosticLevel::Error,
            format!($($arg)*),
        )
    };
}

/// Records at info level. For state changes worth seeing in a bug report —
/// migrations, compactions, recoveries — not for routine activity.
macro_rules! diag_info {
    ($($arg:tt)*) => {
        crate::diagnostics::record(
            crate::diagnostics::DiagnosticLevel::Info,
            format!($($arg)*),
        )
    };
}

pub(crate) use {diag_error, diag_info, diag_warn};
