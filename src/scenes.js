// Scene triggers and scene actions declared in the manifest (Gladys 5.1). The
// triggers are events: each one fires once per transition seen between two
// scheduled refreshes, never once per refresh. The actions only read what the
// integration already knows, or read PBS again with the same GET routes.

export const SCENE_TRIGGERS = {
  TASK_FINISHED: 'task_finished',
  NEW_BACKUP: 'new_backup',
  BACKUP_STALE: 'backup_stale',
  PBS_UNREACHABLE: 'pbs_unreachable',
  PBS_REACHABLE: 'pbs_reachable',
};

export const SCENE_ACTIONS = {
  GET_DATASTORE_STATUS: 'get_datastore_status',
  GET_BACKUP_REPORT: 'get_backup_report',
};

const TASK_LABELS = {
  verify: { en: 'verify', fr: 'vérification' },
  gc: { en: 'garbage collection', fr: 'garbage collection' },
  prune: { en: 'prune', fr: 'prune' },
};

// A published event is capped at 1000 characters per string by the core.
const MAX_EVENT_TEXT = 1000;

/**
 * Compare two summaries of the same datastore and list the scene events the
 * change represents. Without a previous summary (first refresh after a start
 * or a config change) nothing fires: the integration cannot tell a new task
 * from one that finished while it was stopped.
 */
export function detectSceneEvents(previous, current, deviceExternalId) {
  if (!previous) return [];
  const base = { datastore: deviceExternalId, datastore_name: current.store };
  const events = [];

  for (const [type, task] of Object.entries(current.tasks)) {
    const before = previous.tasks?.[type];
    if (task.result === 'never' || task.result === 'running') continue;
    // A new run, or the run seen as running last time that has now ended.
    if (task.id === before?.id && before?.result !== 'running') continue;
    events.push({
      key: SCENE_TRIGGERS.TASK_FINISHED,
      data: {
        ...base,
        task_type: type,
        result: task.result,
        status: String(task.status).slice(0, MAX_EVENT_TEXT),
        date: task.date,
      },
    });
  }

  if (current.newestBackupEpoch > (previous.newestBackupEpoch || 0))
    events.push({
      key: SCENE_TRIGGERS.NEW_BACKUP,
      data: {
        ...base,
        last_backup: current.lastBackup,
        snapshot_count: current.snapshotCount,
      },
    });

  if (current.stale && !previous.stale)
    events.push({
      key: SCENE_TRIGGERS.BACKUP_STALE,
      data: {
        ...base,
        last_backup: current.lastBackup,
        hours_since_backup: current.hoursSinceBackup,
      },
    });

  return events;
}

export function unreachableEvent(store, deviceExternalId, error) {
  return {
    key: SCENE_TRIGGERS.PBS_UNREACHABLE,
    data: {
      datastore: deviceExternalId,
      datastore_name: store,
      error: String(error?.message ?? error).slice(0, MAX_EVENT_TEXT),
    },
  };
}

export function reachableEvent(store, deviceExternalId) {
  return {
    key: SCENE_TRIGGERS.PBS_REACHABLE,
    data: { datastore: deviceExternalId, datastore_name: store },
  };
}

/** Outputs of the `get_datastore_status` scene action. */
export function datastoreStatusOutputs(summary) {
  const { verify, gc, prune } = summary.tasks;
  return {
    datastore_name: summary.store,
    usage_percent: summary.usagePercent,
    used_gb: summary.usedGb,
    total_gb: summary.totalGb,
    snapshot_count: summary.snapshotCount,
    backup_stale: summary.stale,
    last_backup: summary.lastBackup,
    hours_since_backup: summary.hoursSinceBackup,
    last_verify_status: String(verify.status),
    last_verify_date: verify.date,
    last_gc_status: String(gc.status),
    last_gc_date: gc.date,
    last_prune_status: String(prune.status),
    last_prune_date: prune.date,
  };
}

function failedTasks(summary) {
  return Object.entries(summary.tasks)
    .filter(([, task]) => task.result === 'error')
    .map(([type]) => type);
}

function reportLine(summary, language) {
  const fr = language === 'fr';
  const problems = [];
  if (summary.stale)
    problems.push(
      summary.newestBackupEpoch
        ? fr
          ? `dernière sauvegarde il y a ${Math.round(summary.hoursSinceBackup)} h`
          : `last backup ${Math.round(summary.hoursSinceBackup)} h ago`
        : fr
          ? 'aucune sauvegarde'
          : 'no backup',
    );
  for (const type of failedTasks(summary))
    problems.push(fr ? `échec ${TASK_LABELS[type].fr}` : `${TASK_LABELS[type].en} failed`);
  const state = problems.length ? problems.join(', ') : 'OK';
  const usage = fr ? `utilisé ${summary.usagePercent} %` : `${summary.usagePercent}% used`;
  return `${summary.store}${fr ? ' : ' : ': '}${state} (${usage})`;
}

/**
 * Outputs of the `get_backup_report` scene action: counters a scene can test,
 * and a ready-to-send text, one line per datastore. `failures` maps a store
 * name to the error of a refresh that could not reach PBS.
 */
export function backupReportOutputs(summaries, failures = new Map(), language = 'en') {
  const fr = language === 'fr';
  const staleCount = summaries.filter((summary) => summary.stale).length;
  const failedTaskCount = summaries.reduce((total, item) => total + failedTasks(item).length, 0);
  const lines = summaries.map((summary) => reportLine(summary, language));
  for (const store of failures.keys())
    lines.push(fr ? `${store} : PBS injoignable` : `${store}: PBS unreachable`);
  const allOk = staleCount === 0 && failedTaskCount === 0 && failures.size === 0;
  const title = fr ? 'Sauvegardes PBS' : 'PBS backups';
  return {
    datastore_count: summaries.length + failures.size,
    stale_count: staleCount,
    failed_task_count: failedTaskCount,
    unreachable_count: failures.size,
    max_usage_percent: Math.max(0, ...summaries.map((summary) => summary.usagePercent)),
    all_ok: allOk,
    summary: [
      `${title}${fr ? ' : ' : ': '}${allOk ? 'OK' : fr ? 'à vérifier' : 'needs attention'}`,
      ...lines,
    ]
      .join('\n')
      .slice(0, 10_000),
  };
}
