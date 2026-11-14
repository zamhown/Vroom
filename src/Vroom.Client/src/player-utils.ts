export function subtitleToVtt(text: string): string {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (normalized.startsWith('WEBVTT')) return normalized;
  return 'WEBVTT\n\n' + normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}
export function clampTime(time: number, duration: number): number {
  return Math.min(
    Math.max(0, Number.isFinite(time) ? time : 0),
    duration > 0 ? Math.max(0, duration - 0.001) : Infinity,
  );
}
export function parseTimecode(text: string): number | undefined {
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(text.trim())) return;
  const parts = text.trim().split(':').map(Number);
  if (parts.slice(1).some(part => part >= 60)) return;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(seconds) ? seconds : undefined;
}
export function annotationPercent(start: number, end: number | undefined, duration: number) {
  const max = Math.max(1, duration);
  return {
    left: Math.min(100, Math.max(0, (start / max) * 100)),
    width: Math.max(0.25, Math.min(100, (((end ?? start) - start) / max) * 100)),
  };
}
export function shiftedSubtitle(text: string, offset: number): string {
  const vtt = subtitleToVtt(text);
  if (!Number.isFinite(offset) || offset === 0) return vtt;
  const parse = (stamp: string) => stamp.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  const format = (seconds: number) => {
    const ms = Math.max(0, Math.round(seconds * 1000));
    return (
      [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60]
        .map(n => String(n).padStart(2, '0'))
        .join(':') +
      '.' +
      String(ms % 1000).padStart(3, '0')
    );
  };
  return vtt
    .split(/\n\s*\n/)
    .map(block => {
      const match = block.match(/((?:\d{2,}:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})/);
      if (!match) return block;
      if (parse(match[2]) <= offset) return '';
      return block.replace(match[0], `${format(parse(match[1]) - offset)} --> ${format(parse(match[2]) - offset)}`);
    })
    .filter(Boolean)
    .join('\n\n');
}
