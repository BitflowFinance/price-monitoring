import fs from "node:fs";
import path from "node:path";
import { Snapshot, Ticker, IntervalReport, SavedReport } from "./types.js";

const DATA_DIR = path.join(process.cwd(), "data");
const SNAPSHOTS_FILE = path.join(DATA_DIR, "snapshots.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");

/**
 * Write JSON atomically: temp file in the same directory, then rename.
 * Avoids snapshots/reports ending up half-written if the process dies mid-write.
 */
function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(SNAPSHOTS_FILE)) {
    writeJsonAtomic(SNAPSHOTS_FILE, []);
  }
  if (!fs.existsSync(REPORTS_FILE)) {
    writeJsonAtomic(REPORTS_FILE, []);
  }
}

export function loadSnapshots(): Snapshot[] {
  ensureDataDir();
  if (!fs.existsSync(SNAPSHOTS_FILE)) return [];

  try {
    const raw = fs.readFileSync(SNAPSHOTS_FILE, "utf-8");
    return JSON.parse(raw) as Snapshot[];
  } catch {
    console.error("[storage] Failed to parse snapshots file, starting fresh.");
    return [];
  }
}

export function saveSnapshot(tickers: Ticker[]): Snapshot {
  const snapshots = loadSnapshots();
  const now = new Date();

  const newSnapshot: Snapshot = {
    timestamp: now.toISOString(),
    tickers,
  };

  snapshots.push(newSnapshot);

  writeJsonAtomic(SNAPSHOTS_FILE, snapshots);
  console.log(
    `[storage] Saved snapshot at ${newSnapshot.timestamp}. Total kept: ${snapshots.length}`
  );

  return newSnapshot;
}

/**
 * Find the snapshot whose timestamp is closest to (now - targetMs).
 * Returns null if no snapshots exist or none are within tolerance.
 */
export function findClosestSnapshot(
  snapshots: Snapshot[],
  targetMs: number,
  toleranceMs = 10 * 60 * 1000 // ±10 min tolerance
): Snapshot | null {
  if (snapshots.length === 0) return null;

  const targetTime = Date.now() - targetMs;
  let best: Snapshot | null = null;
  let bestDiff = Infinity;

  for (const s of snapshots) {
    const diff = Math.abs(new Date(s.timestamp).getTime() - targetTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }

  if (best && bestDiff <= toleranceMs) return best;
  return null;
}

export function saveReport(report: IntervalReport, runAt: string): void {
  ensureDataDir();

  let reports: SavedReport[] = [];
  if (fs.existsSync(REPORTS_FILE)) {
    try {
      reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf-8")) as SavedReport[];
    } catch {
      console.error("[storage] Failed to parse reports file, starting fresh.");
    }
  }

  reports.push({ ...report, run_at: runAt });

  writeJsonAtomic(REPORTS_FILE, reports);
}
