import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { registerRuntime } from './src/runtime.js';

// Safety net, not error handling: a promise rejected without a handler (a
// late failure in a timer or an SDK callback) would otherwise terminate Node,
// and with it the monitoring of every datastore. It is logged loudly instead.
// No `uncaughtException` handler: a synchronous crash leaves the process in an
// unknown state, and the supervisor's restart is the right answer to it.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

const gladys = new GladysIntegration();
registerRuntime(gladys);
gladys.handleShutdown();

logger.info('Starting Proxmox Backup Server integration...');
gladys.connect().catch((error) => {
  logger.error('Initial connection failed', error);
  process.exit(1);
});
