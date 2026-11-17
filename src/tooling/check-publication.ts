import { checkPublication, checkPublicationHistory } from './publication.js';
if (process.argv.includes('--history'))
  checkPublicationHistory(undefined, process.argv.includes('--all-refs'));
else checkPublication(process.argv.includes('--staged'));
