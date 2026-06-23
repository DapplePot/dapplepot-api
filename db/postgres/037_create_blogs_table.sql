CREATE TABLE IF NOT EXISTS blogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  excerpt TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  authors JSONB NOT NULL,
  tag VARCHAR(100) NOT NULL,
  banner_image_url TEXT NOT NULL,
  meta_title TEXT,
  meta_description TEXT,
  read_time VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by UUID,
  updated_by UUID
);

CREATE INDEX IF NOT EXISTS idx_blogs_tag ON blogs(tag);
CREATE INDEX IF NOT EXISTS idx_blogs_created_at ON blogs(created_at);
