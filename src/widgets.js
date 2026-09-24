import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

// Dashboard widgets declared in the manifest (Gladys 5.1). The integration only
// describes the content; Gladys renders it. The snapshot tile is bound to its
// device feature, so it follows the published state live; the other tiles, the
// task cards and the status rows come from the last refresh and are re-pulled
// after each one.
//
// The card lays its tiles out three per row: both widgets send exactly three so
// no tile is left alone on a row, and format their numbers themselves (rounded,
// localized) instead of showing the two decimals of the raw states.

export const WIDGETS = {
  DATASTORE: 'datastore',
  OVERVIEW: 'overview',
};

export const WIDGET_ACTIONS = {
  REFRESH: 'refresh',
};

// Content is served from memory, so a short TTL is cheap; the integration also
// nudges the widgets after every refresh.
export const WIDGET_TTL_SECONDS = 300;

const USAGE_WARNING_PERCENT = 80;
const USAGE_DANGER_PERCENT = 90;

const TASK_NAMES = {
  verify: { en: 'Verify', fr: 'Vérification' },
  gc: { en: 'Garbage collection', fr: 'Garbage collection' },
  prune: { en: 'Prune', fr: 'Prune' },
};

// Badge texts: 16 characters at most.
const RESULTS = {
  ok: { en: 'Succeeded', fr: 'Réussie', color: WIDGET_COLORS.SUCCESS },
  warning: { en: 'Warnings', fr: 'Avertissements', color: WIDGET_COLORS.WARNING },
  error: { en: 'Failed', fr: 'Échouée', color: WIDGET_COLORS.DANGER },
  running: { en: 'Running', fr: 'En cours', color: WIDGET_COLORS.INFO },
  never: { en: 'Never run', fr: 'Jamais lancée', color: WIDGET_COLORS.NEUTRAL },
};

const REFRESH_BUTTON = {
  type: 'button',
  label: { en: 'Refresh', fr: 'Actualiser' },
  icon: 'refresh-cw',
  style: 'secondary',
  action: { key: WIDGET_ACTIONS.REFRESH },
};

export function usageColor(percent) {
  if (percent >= USAGE_DANGER_PERCENT) return WIDGET_COLORS.DANGER;
  if (percent >= USAGE_WARNING_PERCENT) return WIDGET_COLORS.WARNING;
  return WIDGET_COLORS.SUCCESS;
}

// A number with at most `digits` decimals, trailing zeros dropped, in both
// decimal separators.
function decimal(number, digits) {
  const value = String(Number(number.toFixed(digits)));
  return { en: value, fr: value.replace('.', ',') };
}

// A size in GB split for a tile: `883` `Go` below 1 TB, `2,88` `To` above.
function sizeParts(gb) {
  if (gb >= 1000) return { value: decimal(gb / 1000, 2), unit: { en: 'TB', fr: 'To' } };
  return { value: decimal(gb, gb < 10 ? 1 : 0), unit: { en: 'GB', fr: 'Go' } };
}

/** A size in GB as short localized text: `883 Go` below 1 TB, `2,88 To` above. */
export function formatSize(gb) {
  const { value, unit } = sizeParts(gb);
  return { en: `${value.en} ${unit.en}`, fr: `${value.fr} ${unit.fr}` };
}

function spaceItem(summary) {
  const used = formatSize(summary.usedGb);
  const total = formatSize(summary.totalGb);
  return {
    label: { en: 'Used space', fr: 'Espace utilisé' },
    value: { en: `${used.en} / ${total.en}`, fr: `${used.fr} / ${total.fr}` },
    color: usageColor(summary.usagePercent),
  };
}

// One card per task: name, end date (formatted by Gladys in the user's locale
// and time zone), and the result as a colored badge.
function taskCard(type, task) {
  const result = RESULTS[task.result] ?? RESULTS.error;
  return {
    title: TASK_NAMES[type],
    ...(task.epoch ? { date: new Date(task.epoch * 1000).toISOString() } : {}),
    badge: { text: { en: result.en, fr: result.fr }, color: result.color },
  };
}

function backupItem(summary) {
  return {
    label: { en: 'Last backup', fr: 'Dernière sauvegarde' },
    value: summary.newestBackupEpoch
      ? summary.lastBackup
      : { en: 'No backup', fr: 'Aucune sauvegarde' },
    icon: 'archive',
    color: summary.stale ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
  };
}

/** Content of the `datastore` widget: one datastore in detail. */
export function datastoreWidgetContent(gladys, summary) {
  const ids = gladys.externalIds('pbs-datastore', summary.store);
  return {
    ttl_seconds: WIDGET_TTL_SECONDS,
    components: [
      { type: 'text', variant: 'heading', text: summary.store },
      {
        type: 'gauge',
        label: { en: 'Usage', fr: 'Utilisation' },
        value: Math.round(summary.usagePercent),
        min: 0,
        max: 100,
        unit: '%',
        color: usageColor(summary.usagePercent),
      },
      {
        type: 'value',
        label: { en: 'Free', fr: 'Libre' },
        ...sizeParts(Math.max(0, summary.totalGb - summary.usedGb)),
        icon: 'hard-drive',
      },
      {
        type: 'value',
        label: { en: 'Snapshots', fr: 'Snapshots' },
        device_feature: ids.feature('snapshots'),
        icon: 'layers',
      },
      // One focal component per card: the task cards take the place of a chart.
      {
        type: 'card-list',
        display: 'list',
        items: Object.entries(summary.tasks).map(([type, task]) => taskCard(type, task)),
      },
      { type: 'status', items: [backupItem(summary), spaceItem(summary)] },
      REFRESH_BUTTON,
    ],
  };
}

/** Content of the `datastore` widget when its device no longer exists on PBS. */
export function missingDatastoreContent() {
  return {
    ttl_seconds: WIDGET_TTL_SECONDS,
    components: [
      {
        type: 'text',
        text: {
          en: 'This datastore was not found on the Proxmox Backup Server. Pick another one in the widget settings.',
          fr: 'Ce datastore est introuvable sur le Proxmox Backup Server. Choisissez-en un autre dans les réglages du widget.',
        },
      },
    ],
  };
}

function overviewItem(summary) {
  const failed = Object.values(summary.tasks).some((task) => task.result === 'error');
  let value = { en: 'OK', fr: 'OK' };
  let color = WIDGET_COLORS.SUCCESS;
  if (summary.stale) {
    value = { en: 'Backup stale', fr: 'Sauvegarde ancienne' };
    color = WIDGET_COLORS.DANGER;
  } else if (failed) {
    value = { en: 'Task failed', fr: 'Tâche en échec' };
    color = WIDGET_COLORS.DANGER;
  } else if (summary.usagePercent >= USAGE_WARNING_PERCENT) {
    color = usageColor(summary.usagePercent);
  }
  const usage = `${Math.round(summary.usagePercent)} %`;
  return {
    label: summary.store,
    value: { en: `${value.en} · ${usage}`, fr: `${value.fr} · ${usage}` },
    color,
  };
}

/**
 * Content of the `overview` widget: every datastore on one card. `failures`
 * maps a store name to the error of a refresh that could not reach PBS.
 */
export function overviewWidgetContent(summaries, failures = new Map()) {
  const staleCount = summaries.filter((summary) => summary.stale).length;
  const failedTaskCount = summaries.reduce(
    (total, summary) =>
      total + Object.values(summary.tasks).filter((task) => task.result === 'error').length,
    0,
  );
  const maxUsage = Math.round(Math.max(0, ...summaries.map((summary) => summary.usagePercent)));
  const items = [
    ...summaries.map(overviewItem),
    ...[...failures.keys()].map((store) => ({
      label: store,
      value: { en: 'PBS unreachable', fr: 'PBS injoignable' },
      color: WIDGET_COLORS.DANGER,
    })),
  ];
  return {
    ttl_seconds: WIDGET_TTL_SECONDS,
    components: [
      // The status rows already list every datastore: no count tile.
      {
        type: 'gauge',
        label: { en: 'Max usage', fr: 'Utilisation max' },
        value: maxUsage,
        min: 0,
        max: 100,
        unit: '%',
        color: usageColor(maxUsage),
      },
      {
        type: 'value',
        label: { en: 'Stale backups', fr: 'Sauv. en retard' },
        value: staleCount,
        icon: 'clock',
        color: staleCount ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
      },
      {
        type: 'value',
        label: { en: 'Failed tasks', fr: 'Tâches en échec' },
        value: failedTaskCount,
        icon: 'alert-triangle',
        color: failedTaskCount ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
      },
      // The status list holds at most 10 rows: the core drops the rest.
      ...(items.length ? [{ type: 'status', items: items.slice(0, 10) }] : []),
      REFRESH_BUTTON,
    ],
  };
}
