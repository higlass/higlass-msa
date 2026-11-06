import register from 'higlass-register';

import MsaTrack from './MsaTrack.js';
import ServerDataFetcher from './server/ServerDataFetcher.js';
import SyntheticDataFetcher from './synthetic/SyntheticDataFetcher.js';

register({ track: MsaTrack, config: MsaTrack.config });
for (const fetcher of [SyntheticDataFetcher, ServerDataFetcher]) {
  register({ dataFetcher: fetcher, config: fetcher.config }, { pluginType: 'dataFetcher' });
}

export { MsaTrack, ServerDataFetcher, SyntheticDataFetcher };
