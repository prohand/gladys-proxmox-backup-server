import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

// Dashboard widgets declared in the manifest (Gladys 5.1). The integration only
// describes the content; Gladys renders it. Capacity tiles and the chart are
// bound to the device features, so they follow the published states live; the
// status rows come from the last refresh and are re-pulled after each one.

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

const RESULTS = {
  ok: { en: 'OK', fr: 'OK', color: WIDGET_COLORS.SUCCESS },
  warning: { en: 'Warnings', fr: 'Avertissements', color: WIDGET_COLORS.WARNING },
  error: { en: 'Error', fr: 'Erreur', color: WIDGET_COLORS.DANGER },
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

// A status value holds 40 characters: the milliseconds of an ISO date would
// push "Avertissements · <date>" past it.
function withDate(text, date) {
  if (!date) return { en: text.en, fr: text.fr };
  const short = date.replace(/\.\d{3}Z$/, 'Z');
  return { en: `${text.en} · ${short}`, fr: `${text.fr} · ${short}` };
}

function taskItem(type, task) {
  const result = RESULTS[task.result] ?? RESULTS.error;
  return {
    label: TASK_NAMES[type],
    value: withDate(result, task.result === 'never' ? null : task.date),
    color: result.color,
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
        device_feature: ids.feature('usage'),
        min: 0,
        max: 100,
        unit: '%',
        color: usageColor(summary.usagePercent),
      },
      {
        type: 'value',
        label: { en: 'Used', fr: 'Utilisé' },
        device_feature: ids.feature('used'),
        icon: 'hard-drive',
      },
      {
        type: 'value',
        label: { en: 'Total', fr: 'Total' },
        device_feature: ids.feature('total'),
        icon: 'database',
      },
      {
        type: 'value',
        label: { en: 'Snapshots', fr: 'Snapshots' },
        device_feature: ids.feature('snapshots'),
        icon: 'layers',
      },
      {
        type: 'chart',
        title: { en: 'Usage', fr: 'Utilisation' },
        chart_type: 'area',
        device_features: [ids.feature('usage')],
        interval: 'last-month',
      },
      {
        type: 'status',
        items: [
          backupItem(summary),
          ...Object.entries(summary.tasks).map(([type, task]) => taskItem(type, task)),
        ],
      },
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
  const maxUsage = Math.max(0, ...summaries.map((summary) => summary.usagePercent));
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
      {
        type: 'value',
        label: { en: 'Datastores', fr: 'Datastores' },
        value: summaries.length + failures.size,
        icon: 'database',
      },
      {
        type: 'value',
        label: { en: 'Stale backups', fr: 'Sauvegardes anciennes' },
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
      {
        type: 'gauge',
        label: { en: 'Fullest datastore', fr: 'Datastore le + plein' },
        value: maxUsage,
        min: 0,
        max: 100,
        unit: '%',
        color: usageColor(maxUsage),
      },
      // The status list holds at most 10 rows: the core drops the rest.
      ...(items.length ? [{ type: 'status', items: items.slice(0, 10) }] : []),
      REFRESH_BUTTON,
    ],
  };
}
