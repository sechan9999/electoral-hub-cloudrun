export interface ElectionRecord {
  Election: string;
  Candidates: Record<string, number>;
  'Total Votes': number;
  Voters: number;
  Turnout: number;
}

export interface RegionalRecord {
  [region: string]: {
    Conservative: number;
    Democratic: number;
  };
}
