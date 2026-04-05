export interface ExtractedJob {
  url: string
  extracted_at: number
  title: string
  company: string
  location: string
  salary_range?: string
  employment_type?: string
  experience_level?: string
  description: string
  requirements: string[]
  benefits: string[]
}
