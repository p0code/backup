import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** Remote object names and which ones to delete; the name alone says whose backup it is and when. */

export const BACKUP_SUFFIX = ".p0bak";
const NAME = /^p0code-([A-Za-z0-9-]{1,64})-(\d{8}T\d{6}Z)\.p0bak$/;

export interface ParsedBackupName {
  readonly environmentId: string;
  /** Epoch milliseconds, to the second. */
  readonly createdAt: number;
}

const stamp = (epochMs: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(epochMs))
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Environment IDs outside the name's alphabet keep only the characters that fit. */
export const nameId = (environmentId: string) =>
  environmentId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "unknown";

export function backupName(environmentId: string, createdAt: number): string {
  return `p0code-${nameId(environmentId)}-${stamp(createdAt)}${BACKUP_SUFFIX}`;
}

export function parseBackupName(name: string): ParsedBackupName | null {
  const match = NAME.exec(name);
  if (match === null) return null;
  const [, environmentId, raw] = match;
  const iso = `${raw!.slice(0, 4)}-${raw!.slice(4, 6)}-${raw!.slice(6, 11)}:${raw!.slice(11, 13)}:${raw!.slice(13, 15)}Z`;
  return Option.match(DateTime.make(iso), {
    onNone: () => null,
    onSome: (date) => ({ environmentId: environmentId!, createdAt: DateTime.toEpochMillis(date) }),
  });
}

/**
 * The backups retention removes: this environment's own, beyond the newest `keep`.
 * Other machines' backups and files this plugin did not name are never selected, so a
 * new install never prunes the backups it may need to restore from.
 */
export function selectForDeletion(
  names: ReadonlyArray<string>,
  environmentId: string,
  keep: number,
): string[] {
  const own = nameId(environmentId);
  return names
    .flatMap((name) => {
      const parsed = parseBackupName(name);
      return parsed?.environmentId === own ? [{ name, at: parsed.createdAt }] : [];
    })
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1))
    .slice(Math.max(1, Math.floor(keep)))
    .map((entry) => entry.name);
}
