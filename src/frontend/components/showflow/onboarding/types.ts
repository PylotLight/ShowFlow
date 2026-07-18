export interface WizardData {
  step: number;
  completed: boolean;
  rootFolders: string[];
  libraryTypeId: string | null;
  qualityProfileId: string | null;
  sonarr: SonarrWizardData;
  prowlarr: ProwlarrWizardData;
  downloadClient: DownloadClientWizardData;
  theme: Record<string, unknown>;
}

export interface SonarrWizardData {
  baseUrl: string;
  apiKey: string;
  apiVersion: 'v3' | 'v5';
  tested: boolean;
  series: SonarrSeries[];
  typeMapping: Record<string, string>;
  importJobId: string | null;
  importForkMode: 'background' | 'watch' | null;
}

export interface SonarrSeries {
  id: number;
  title: string;
  year: number;
  status: string;
  seriesType: string;
  path: string;
  seasons: { seasonNumber: number }[];
}

export interface ProwlarrWizardData {
  baseUrl: string;
  apiKey: string;
  syncLevel: 'full' | 'addRemoveOnly' | 'disabled';
  tested: boolean;
}

export interface DownloadClientWizardData {
  type: 'none' | 'blackhole' | 'torbox' | 'sabnzbd';
  config: Record<string, string>;
}

export interface StepProps {
  data: WizardData;
  setData: (updates: Partial<WizardData>) => void;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  isFirst: boolean;
  isLast: boolean;
}

export const STEPS = [
  { id: 'welcome', label: 'Welcome', short: 'Start' },
  { id: 'folders', label: 'Root Folders', short: 'Folders' },
  { id: 'library-type', label: 'Library & Quality', short: 'Library' },
  { id: 'integrations', label: 'Integrations', short: 'Integrate' },
  { id: 'theme', label: 'Theme', short: 'Theme' },
  { id: 'health', label: 'Health Check', short: 'Health' },
  { id: 'done', label: 'Done', short: 'Done' },
] as const;

export const TOTAL_STEPS = STEPS.length;

export const DEFAULT_WIZARD_DATA: WizardData = {
  step: 0,
  completed: false,
  rootFolders: [],
  libraryTypeId: null,
  qualityProfileId: null,
  sonarr: {
    baseUrl: '',
    apiKey: '',
    apiVersion: 'v3',
    tested: false,
    series: [],
    typeMapping: {},
    importJobId: null,
    importForkMode: null,
  },
  prowlarr: {
    baseUrl: '',
    apiKey: '',
    syncLevel: 'full',
    tested: false,
  },
  downloadClient: {
    type: 'none',
    config: {},
  },
  theme: {},
};
