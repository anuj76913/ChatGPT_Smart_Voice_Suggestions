import { createContext, useContext } from 'react';
import type { ClientConfig } from '@svs/shared';

/** Phase 11 v2 feature flags from the client config (the server enforces them too). */
export type Features = ClientConfig['features'];
export const FeaturesContext = createContext<Features>({ preview_mode: false, quiet_mode: false });
export const useFeatures = () => useContext(FeaturesContext);
