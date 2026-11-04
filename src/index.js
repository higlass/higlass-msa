import register from 'higlass-register';

import MsaTrack from './MsaTrack.js';
import SyntheticDataFetcher from './synthetic/SyntheticDataFetcher.js';

register({ track: MsaTrack, config: MsaTrack.config });
register(
  { dataFetcher: SyntheticDataFetcher, config: SyntheticDataFetcher.config },
  { pluginType: 'dataFetcher' },
);

export { MsaTrack, SyntheticDataFetcher };
