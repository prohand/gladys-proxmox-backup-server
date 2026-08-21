import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { registerRuntime } from './src/runtime.js';

const gladys = new GladysIntegration();
registerRuntime(gladys);
gladys.handleShutdown();

logger.info('Starting Proxmox Backup Server integration...');
gladys.connect().catch((error) => {
  logger.error('Initial connection failed', error);
  process.exit(1);
});
