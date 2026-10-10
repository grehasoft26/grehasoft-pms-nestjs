export class UpdateSeoReportDto {
  report_title?: string;
  report_month?: string;
  period_start_date?: string;
  period_end_date?: string;

  executive_summary?: string;
  key_achievements?: string[];
  challenges_notes?: string;
  recommendations?: string[];
  next_month_plan?: string[];

  domain_authority?: number;
  previous_da?: number;
  page_authority?: number;
  spam_score?: number;
  health_score?: number;
  total_indexed_pages?: number;
  total_backlinks?: number;

  gsc_clicks?: number;
  gsc_prev_clicks?: number;
  gsc_impressions?: number;
  gsc_prev_impressions?: number;
  gsc_avg_ctr?: number;
  gsc_prev_avg_ctr?: number;
  gsc_avg_position?: number;
  gsc_prev_avg_position?: number;

  ga4_organic_users?: number;
  ga4_prev_users?: number;
  ga4_new_users?: number;
  ga4_sessions?: number;
  ga4_prev_sessions?: number;
  ga4_engagement_rate?: number;
  ga4_avg_session_duration?: string;

  gbp_profile_views?: number;
  gbp_prev_views?: number;
  gbp_interactions?: number;
  gbp_phone_calls?: number;
  gbp_direction_requests?: number;
  gbp_website_clicks?: number;
}
