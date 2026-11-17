import { checkPublication, checkPublicationHistory } from './publication.js';
if (process.argv.includes('--history')) checkPublicationHistory();
else checkPublication(process.argv.includes('--staged'));
