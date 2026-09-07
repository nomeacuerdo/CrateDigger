const CLEAR_LINE = "\x1b[2K\x1b[G";

// Formats a duration in seconds as a compact h/m/s string.
export function formatTime(totalSeconds) {
  const secs = Math.floor(totalSeconds % 60);
  const mins = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  if (hours) return `${hours}h ${String(mins).padStart(2, "0")}m`;
  if (mins) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

// Live single-line CLI progress indicator: done/total, %, elapsed, ETA and a custom suffix.
export class Progress {
  // Creates the indicator with a label and the expected total number of work items.
  constructor(label, total = 0) {
    this.label = label;
    this.total = total;
    this.done = 0;
    this.start = Date.now();
    this.prev = Date.now();
    this.avg = 0;
  }

  // Updates the total, used when a page response reveals the real item count.
  setTotal(total) {
    this.total = total;
  }

  // Reports an absolute amount of work done (used when resuming mid-phase).
  record(done, suffix = "") {
    this.done = done;
    this.render(suffix);
  }

  // Advances work by one item, keeps a rolling average for the ETA, and redraws the line.
  tick(suffix = "") {
    this.done++;
    if (this.done > this.total) this.setTotal(this.done);
    const now = Date.now();
    const dt = now - this.prev;
    this.prev = now;
    this.avg = this.avg === 0 ? dt : this.avg * 0.9 + dt * 0.1;
    this.render(suffix);
  }

  // Draws the progress line, computing elapsed time, ETA and percentage complete.
  render(suffix = "") {
    const elapsed = Math.round((Date.now() - this.start) / 1000);
    const remaining = Math.max(0, this.total - this.done);
    const eta = remaining > 0 && this.avg > 0 ? Math.round((remaining * this.avg) / 1000) : 0;
    const pct = this.total > 0 ? ((this.done / this.total) * 100).toFixed(1) : "-";
    const line = [
      this.label,
      `${this.done}/${this.total}`,
      `(${pct}%)`,
      `elapsed ${formatTime(elapsed)}`,
      eta !== 0 ? `eta ${formatTime(eta)}` : "",
      suffix,
    ]
      .filter(Boolean)
      .join("  ");
    process.stdout.write(`${CLEAR_LINE}${line}`);
  }

  // Redraws (if a suffix is given) and moves to the next line when a phase ends.
  finish(suffix = "") {
    if (suffix) this.render(suffix);
    process.stdout.write("\n");
  }

  // Prints a message on its own line, used for rate-limit countdowns without advancing progress.
  wait(message) {
    process.stdout.write(`${CLEAR_LINE}${message}`);
  }
}