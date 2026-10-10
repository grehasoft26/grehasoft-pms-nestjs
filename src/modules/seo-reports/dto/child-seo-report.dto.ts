export class UpdateSeoReportStatusDto {
  status?: string;
  remarks?: string;
}

export class CreateSeoReportKeywordDto {
  keyword: string;
  target_url?: string;
  search_engine?: string;
  initial_rank?: number;
  previous_rank?: number;
  current_rank?: number;
  target_rank?: number;
  rank_change?: number;
}

export class UpdateSeoReportKeywordDto {
  keyword?: string;
  target_url?: string;
  search_engine?: string;
  initial_rank?: number;
  previous_rank?: number;
  current_rank?: number;
  target_rank?: number;
  rank_change?: number;
}

export class CreateSeoReportTopQueryDto {
  query_text: string;
  clicks?: number;
  impressions?: number;
  ctr?: number;
  average_position?: number;
}

export class UpdateSeoReportTopQueryDto {
  query_text?: string;
  clicks?: number;
  impressions?: number;
  ctr?: number;
  average_position?: number;
}

export class CreateSeoReportTrafficSourceDto {
  channel_group: string;
  users_count?: number;
  percentage?: number;
}

export class UpdateSeoReportTrafficSourceDto {
  channel_group?: string;
  users_count?: number;
  percentage?: number;
}

export class CreateSeoReportActivitySummaryDto {
  activity_name: string;
  completed_count?: number;
  notes?: string;
}

export class UpdateSeoReportActivitySummaryDto {
  activity_name?: string;
  completed_count?: number;
  notes?: string;
}
