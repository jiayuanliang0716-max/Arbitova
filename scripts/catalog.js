// catalog.js — Comprehensive AI service catalog for A2A Market cold-start
// 40 services across 8 categories

const CATEGORIES = {
  FINANCE:     'Finance & Investment',
  CONTENT:     'Content & Writing',
  TRANSLATION: 'Translation & Language',
  DATA:        'Data & Analytics',
  CODE:        'Code & Technical',
  DESIGN:      'Design & Creative',
  BUSINESS:    'Business & Strategy',
  EDUCATION:   'Education & Learning',
};

// Agent profile per category
const AGENTS = [
  { slug: 'finance',     name: 'FinanceBot Pro',       description: 'AI-powered financial analysis, stock insights, and investment research.' },
  { slug: 'content',     name: 'ContentCraft AI',      description: 'Professional AI copywriting for blogs, ads, emails, and social media.' },
  { slug: 'translation', name: 'LinguaBridge AI',      description: 'Accurate multilingual translation and localization services.' },
  { slug: 'data',        name: 'DataLens Analytics',   description: 'Turn raw data into actionable insights with AI-powered analysis.' },
  { slug: 'code',        name: 'CodeAssist Pro',       description: 'AI developer tools for code review, documentation, and query generation.' },
  { slug: 'design',      name: 'CreativeEdge AI',      description: 'AI-driven creative direction, branding, and design feedback.' },
  { slug: 'business',    name: 'StrategyPilot AI',     description: 'Business strategy, planning, and organizational intelligence.' },
  { slug: 'education',   name: 'EduSpark AI',          description: 'AI learning tools for educators and students.' },
];

const SERVICES = [

  // ═══════════════════════════════════════════════════════════════
  // FINANCE & INVESTMENT
  // ═══════════════════════════════════════════════════════════════
  {
    category: 'finance',
    name: 'Stock Technical Analysis',
    name_zh: '股票技術分析報告',
    description: 'Get a professional technical analysis report for any stock ticker. Includes trend assessment, support/resistance levels, volume analysis, and actionable trading signals. Perfect for day traders and swing traders.',
    price: 2.00,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol (e.g., TSLA, AAPL, 2330.TW)' },
        timeframe: { type: 'string', enum: ['short-term', 'mid-term', 'long-term'], description: 'Analysis timeframe' }
      },
      required: ['ticker']
    },
    output_schema: {
      type: 'object',
      properties: {
        trend: { type: 'string' },
        support_levels: { type: 'array' },
        resistance_levels: { type: 'array' },
        recommendation: { type: 'string' },
        risk_warning: { type: 'string' }
      }
    },
    promptFn: (req) => `You are an expert technical analyst. Generate a professional technical analysis report for the stock "${req || 'TSLA'}".

Include these sections:
1. **Trend Assessment** — Current trend direction (bullish/bearish/consolidating) with reasoning (2-3 sentences)
2. **Key Support Levels** — 2-3 price levels with brief explanation
3. **Key Resistance Levels** — 2-3 price levels with brief explanation
4. **Volume Analysis** — Recent volume patterns and implications
5. **Technical Indicators** — RSI, MACD, Moving Averages summary
6. **Trading Signal** — Clear recommendation (Buy/Hold/Sell) with entry/exit suggestions
7. **Risk Assessment** — Key risks and stop-loss recommendation

Format with clear headers. Be specific with price levels. End with a disclaimer that this is AI-generated analysis and not financial advice.`
  },

  {
    category: 'finance',
    name: 'Crypto Market Analysis',
    name_zh: '加密貨幣市場分析',
    description: 'Comprehensive analysis of any cryptocurrency including market sentiment, on-chain metrics overview, technical levels, and market cycle positioning. Covers BTC, ETH, and all major altcoins.',
    price: 2.50,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Cryptocurrency name or symbol (e.g., BTC, ETH, SOL)' }
      },
      required: ['coin']
    },
    output_schema: {
      type: 'object',
      properties: {
        sentiment: { type: 'string' },
        technical_outlook: { type: 'string' },
        risk_level: { type: 'string' }
      }
    },
    promptFn: (req) => `You are a crypto market analyst. Generate a comprehensive market analysis for "${req || 'BTC'}".

Include:
1. **Market Overview** — Current price context and recent performance
2. **Sentiment Analysis** — Overall market sentiment (Fear/Neutral/Greed) and social signals
3. **Technical Analysis** — Key levels, trend direction, chart patterns
4. **Fundamental Factors** — Network activity, development updates, ecosystem news
5. **Market Cycle Position** — Where we are in the broader cycle
6. **Risk/Reward Assessment** — Upside potential vs downside risk
7. **Outlook** — Short-term (1 week) and mid-term (1 month) expectations

Be balanced and data-driven. Include a disclaimer.`
  },

  {
    category: 'finance',
    name: 'Financial Report Summary',
    name_zh: '財報摘要分析',
    description: 'Upload or paste any earnings report, 10-K, or financial statement and receive a concise executive summary highlighting key metrics, growth trends, and red flags. Saves hours of reading.',
    price: 3.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name' },
        report_content: { type: 'string', description: 'Paste the financial report text or key data points' }
      },
      required: ['company']
    },
    output_schema: {
      type: 'object',
      properties: { summary: { type: 'string' }, key_metrics: { type: 'object' }, red_flags: { type: 'array' } }
    },
    promptFn: (req) => `You are a CFA-level financial analyst. Summarize the following financial report or company data for "${req || 'a company'}".

Provide:
1. **Executive Summary** — 3-4 sentence overview
2. **Key Financial Metrics** — Revenue, net income, EPS, margins, YoY growth
3. **Strengths** — 3-4 positive highlights
4. **Red Flags & Risks** — 2-3 concerns
5. **Peer Comparison Context** — How does this compare to industry averages?
6. **Investor Takeaway** — 2-3 sentence bottom line

If only a company name is provided without data, provide a general overview based on publicly known recent performance. Format clearly with headers.`
  },

  {
    category: 'finance',
    name: 'Portfolio Risk Assessment',
    name_zh: '投資組合風險評估',
    description: 'Submit your portfolio holdings and receive a detailed risk assessment including diversification score, sector concentration, correlation analysis, and rebalancing suggestions.',
    price: 5.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        holdings: { type: 'string', description: 'List your holdings with approximate allocations (e.g., AAPL 30%, MSFT 20%, BTC 15%)' }
      },
      required: ['holdings']
    },
    output_schema: {
      type: 'object',
      properties: { risk_score: { type: 'number' }, diversification_grade: { type: 'string' }, recommendations: { type: 'array' } }
    },
    promptFn: (req) => `You are a portfolio risk analyst. Analyze the following investment portfolio:

${req || 'AAPL 25%, MSFT 20%, GOOGL 15%, TSLA 10%, BTC 10%, ETH 5%, Cash 15%'}

Provide a comprehensive risk assessment:
1. **Overall Risk Score** — 1-10 scale with explanation
2. **Diversification Grade** — A-F with reasoning
3. **Sector Concentration** — Breakdown and concerns
4. **Correlation Analysis** — Which holdings move together
5. **Stress Test Scenarios** — How portfolio might perform in: market crash, interest rate hike, tech selloff
6. **Rebalancing Recommendations** — Specific suggestions to improve risk/return
7. **Key Risks** — Top 3 portfolio-specific risks

Be specific and actionable. Disclaimer: not financial advice.`
  },

  {
    category: 'finance',
    name: 'Daily Market Brief',
    name_zh: '每日市場簡報',
    description: 'Subscribe to receive a daily AI-generated market briefing covering major indices, sector movers, economic calendar, and key events to watch. Start your trading day informed.',
    price: 1.00,
    delivery_hours: 1,
    product_type: 'subscription',
    market_type: 'h2a',
    sub_interval: 'daily',
    sub_price: 0.50,
    input_schema: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: 'Market focus: US, Asia, Europe, or Crypto' }
      }
    },
    output_schema: {
      type: 'object',
      properties: { brief: { type: 'string' }, date: { type: 'string' } }
    },
    promptFn: (req) => `Generate a concise daily market brief for ${req || 'US markets'}.

Format:
## Daily Market Brief

**Market Sentiment:** (one line)

**Key Indices:** List 4-5 major indices with directional context

**Sector Watch:** Top 2 sectors to watch today and why

**Economic Calendar:** Key events/data releases today

**Earnings Spotlight:** Notable earnings if any

**What to Watch:** 3 bullet points on key themes

**Trading Idea:** One actionable observation

Keep it under 400 words. Professional tone. Add today's context based on general market conditions.`
  },

  // ═══════════════════════════════════════════════════════════════
  // CONTENT & WRITING
  // ═══════════════════════════════════════════════════════════════
  {
    category: 'content',
    name: 'SEO Blog Post Generator',
    name_zh: 'SEO 部落格文章產生器',
    description: 'Generate a fully optimized, publish-ready blog post of 1000-1500 words on any topic. Includes meta title, meta description, headers, internal linking suggestions, and a call-to-action. Optimized for search engines.',
    price: 3.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Blog post topic or target keyword' },
        tone: { type: 'string', enum: ['professional', 'casual', 'authoritative', 'friendly'], description: 'Writing tone' },
        word_count: { type: 'number', description: 'Target word count (default: 1200)' }
      },
      required: ['topic']
    },
    output_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, meta_description: { type: 'string' }, content: { type: 'string' }, suggested_tags: { type: 'array' } }
    },
    promptFn: (req) => `You are an expert SEO content writer. Write a comprehensive, SEO-optimized blog post about: "${req || 'AI tools for small businesses'}"

Requirements:
- **Meta Title** (under 60 chars, includes primary keyword)
- **Meta Description** (under 155 chars, compelling with CTA)
- **Content**: 1000-1500 words with:
  - Engaging introduction with hook
  - H2 and H3 subheadings (keyword-rich)
  - Short paragraphs (2-3 sentences each)
  - Bullet points or numbered lists where appropriate
  - Statistics or data points for credibility
  - Natural keyword integration (no stuffing)
  - Internal linking suggestions [marked in brackets]
- **Conclusion** with clear call-to-action
- **Suggested Tags**: 5-8 relevant tags

Write naturally and engagingly. The content should provide genuine value to readers.`
  },

  {
    category: 'content',
    name: 'Product Description Writer',
    name_zh: '商品描述撰寫',
    description: 'Craft persuasive product descriptions that convert browsers into buyers. Provides a main description, bullet-point features, and a compelling value proposition. Works for e-commerce, SaaS, or physical products.',
    price: 1.00,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Name of the product' },
        features: { type: 'string', description: 'Key features and specifications' },
        target_audience: { type: 'string', description: 'Who is this product for?' }
      },
      required: ['product_name']
    },
    output_schema: {
      type: 'object',
      properties: { headline: { type: 'string' }, description: { type: 'string' }, bullet_points: { type: 'array' } }
    },
    promptFn: (req) => `You are a conversion-focused copywriter. Write a compelling product description for: "${req || 'a wireless noise-canceling headphone'}"

Deliver:
1. **Headline** — Attention-grabbing, benefit-driven (under 10 words)
2. **Subheadline** — Supporting statement (1 sentence)
3. **Main Description** — 2-3 paragraphs focusing on benefits, not just features. Use sensory language and emotional triggers.
4. **Key Features** — 5-6 bullet points (feature → benefit format)
5. **Social Proof Line** — A suggested testimonial-style statement
6. **CTA** — Compelling call-to-action

Write for conversion. Use power words. Keep it scannable.`
  },

  {
    category: 'content',
    name: 'Email Copy Suite',
    name_zh: '行銷郵件文案套組',
    description: 'Get a complete email marketing suite: welcome email, promotional email, follow-up sequence, and re-engagement email. Each with subject lines, preview text, and A/B variants. Ready to drop into any ESP.',
    price: 4.00,
    delivery_hours: 3,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        business: { type: 'string', description: 'Business name and type' },
        goal: { type: 'string', description: 'Campaign goal (e.g., product launch, re-engagement, nurture)' },
        offer: { type: 'string', description: 'Special offer or key message' }
      },
      required: ['business']
    },
    output_schema: {
      type: 'object',
      properties: { emails: { type: 'array' }, subject_lines: { type: 'array' } }
    },
    promptFn: (req) => `You are an email marketing expert. Create a complete email marketing suite for: "${req || 'an online fitness coaching platform launching a new program'}"

Deliver 4 emails:

**Email 1: Welcome / Announcement**
- Subject line (+ A/B variant)
- Preview text
- Body (150-200 words)

**Email 2: Value / Education**
- Subject line (+ A/B variant)
- Preview text
- Body (150-200 words)

**Email 3: Social Proof / Testimonial**
- Subject line (+ A/B variant)
- Preview text
- Body (150-200 words)

**Email 4: Urgency / Final CTA**
- Subject line (+ A/B variant)
- Preview text
- Body (150-200 words)

Each email should have a clear CTA button text. Use proven email copywriting frameworks (PAS, AIDA). Include personalization tokens like {first_name}.`
  },

  {
    category: 'content',
    name: 'Social Media Content Pack',
    name_zh: '社群媒體內容包',
    description: 'A week of social media content: 7 posts for your choice of platform (Twitter/X, LinkedIn, Instagram, or Facebook). Each with copy, hashtags, and posting time suggestions. Save hours of content planning.',
    price: 2.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand or business name and niche' },
        platform: { type: 'string', enum: ['twitter', 'linkedin', 'instagram', 'facebook'], description: 'Target platform' },
        theme: { type: 'string', description: 'Weekly theme or key message' }
      },
      required: ['brand']
    },
    output_schema: {
      type: 'object',
      properties: { posts: { type: 'array' }, content_calendar: { type: 'object' } }
    },
    promptFn: (req) => `You are a social media strategist. Create a 7-day content pack for: "${req || 'a SaaS startup on Twitter/X'}"

For each day (Monday-Sunday), provide:
- **Post Copy** (platform-appropriate length and style)
- **Hashtags** (3-5 relevant ones)
- **Best Posting Time** (with timezone note)
- **Content Type** (educational, entertaining, promotional, engagement, story)
- **Image/Visual Suggestion** (brief description of ideal accompanying visual)

Include a mix of:
- 2 educational/value posts
- 2 engagement posts (questions, polls)
- 1 promotional post
- 1 behind-the-scenes/story post
- 1 trending/timely post

Each post should be ready to copy-paste and publish.`
  },

  {
    category: 'content',
    name: 'Press Release Writer',
    name_zh: '新聞稿撰寫',
    description: 'Professional press release following AP style guidelines. Includes headline, dateline, lead paragraph, quotes, boilerplate, and media contact section. Ready to distribute to journalists and wire services.',
    price: 3.00,
    delivery_hours: 3,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name' },
        announcement: { type: 'string', description: 'What is being announced?' },
        quotes: { type: 'string', description: 'Who should be quoted? (name, title)' }
      },
      required: ['announcement']
    },
    output_schema: {
      type: 'object',
      properties: { headline: { type: 'string' }, subheadline: { type: 'string' }, body: { type: 'string' } }
    },
    promptFn: (req) => `You are a PR professional. Write a press release for: "${req || 'a tech startup announcing a $10M Series A funding round'}"

Follow AP style. Include:
1. **Headline** — Compelling, newsworthy (under 80 chars)
2. **Subheadline** — Supporting detail
3. **Dateline** — City, Date
4. **Lead Paragraph** — Who, what, when, where, why (the most important info)
5. **Body** — 3-4 paragraphs expanding on the story, context, and significance
6. **Quote** — 1-2 executive quotes (use placeholder names if not provided)
7. **About Section** — Company boilerplate
8. **Media Contact** — Template section

Professional tone. No fluff. Newsworthy angle.`
  },

  // ═══════════════════════════════════════════════════════════════
  // TRANSLATION & LANGUAGE
  // ═══════════════════════════════════════════════════════════════
  {
    category: 'translation',
    name: 'English ↔ Chinese Translation',
    name_zh: '英中互譯',
    description: 'High-quality bidirectional English-Chinese translation that preserves tone, context, and cultural nuance. Supports both Traditional and Simplified Chinese. Ideal for business documents, marketing copy, and technical content.',
    price: 1.50,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to translate' },
        target: { type: 'string', enum: ['en', 'zh-TW', 'zh-CN'], description: 'Target language' },
        style: { type: 'string', enum: ['formal', 'casual', 'technical', 'literary'], description: 'Translation style' }
      },
      required: ['text']
    },
    output_schema: {
      type: 'object',
      properties: { translation: { type: 'string' }, notes: { type: 'string' } }
    },
    promptFn: (req) => `You are a professional translator fluent in English, Traditional Chinese, and Simplified Chinese. Translate the following text:

"${req || 'Please provide text to translate.'}"

Instructions:
- Auto-detect the source language
- If source is English, translate to Traditional Chinese (繁體中文) unless otherwise specified
- If source is Chinese, translate to English
- Preserve the tone, style, and intent of the original
- For cultural references, provide the closest equivalent with a translator note
- For proper nouns, keep original with translation in parentheses
- Maintain formatting (paragraphs, bullet points, etc.)

Output:
1. **Translation**
2. **Translator Notes** (if any cultural adaptations or ambiguities exist)`
  },

  {
    category: 'translation',
    name: 'Multi-Language Translation',
    name_zh: '多語言翻譯',
    description: 'Translate your content into up to 5 languages simultaneously. Supports 20+ languages including Japanese, Korean, Spanish, French, German, and more. Each translation is culturally adapted, not just word-for-word.',
    price: 3.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to translate' },
        target_languages: { type: 'string', description: 'Comma-separated target languages (e.g., Japanese, Korean, Spanish)' }
      },
      required: ['text', 'target_languages']
    },
    output_schema: {
      type: 'object',
      properties: { translations: { type: 'object' } }
    },
    promptFn: (req) => `You are a professional multilingual translator. Translate the following into the requested languages:

"${req || 'Hello, please provide text and target languages (e.g., Japanese, Korean, Spanish).'}"

For each target language:
1. Provide the translation
2. Add a brief note on any cultural adaptation made
3. Include romanization/pronunciation guide for non-Latin scripts

Ensure each translation sounds natural to native speakers, not like a machine translation. Preserve formatting and tone.`
  },

  {
    category: 'translation',
    name: 'Document Localization',
    name_zh: '文件在地化',
    description: 'Go beyond translation: fully localize your document for a target market. Adapts date formats, currency, measurement units, cultural references, idioms, and compliance language. Perfect for expanding to new markets.',
    price: 5.00,
    delivery_hours: 4,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Document content to localize' },
        target_market: { type: 'string', description: 'Target market (e.g., Japan, Germany, Taiwan)' },
        document_type: { type: 'string', description: 'Type: marketing, legal, technical, UI strings' }
      },
      required: ['document', 'target_market']
    },
    output_schema: {
      type: 'object',
      properties: { localized_content: { type: 'string' }, localization_notes: { type: 'array' } }
    },
    promptFn: (req) => `You are a localization expert. Localize the following content for the target market:

${req || 'Please provide document content and target market.'}

Localization tasks:
1. **Translate** — Natural, native-sounding translation
2. **Cultural Adaptation** — Adjust idioms, metaphors, humor for the target culture
3. **Format Localization** — Dates, numbers, currency, units, addresses, phone formats
4. **Legal/Compliance** — Note any region-specific legal requirements
5. **UI/UX Considerations** — Text expansion/contraction notes, RTL concerns if applicable

Provide:
- The fully localized document
- A localization changelog listing every adaptation made and why`
  },

  {
    category: 'translation',
    name: 'Subtitle Translation',
    name_zh: '字幕翻譯',
    description: 'Translate subtitle text while preserving timing cues and readability constraints. Handles SRT format, keeps lines under character limits, and maintains natural speech rhythm. Supports all major language pairs.',
    price: 2.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        subtitles: { type: 'string', description: 'Subtitle text (SRT format or plain text with timestamps)' },
        target_language: { type: 'string', description: 'Target language for translation' }
      },
      required: ['subtitles', 'target_language']
    },
    output_schema: {
      type: 'object',
      properties: { translated_subtitles: { type: 'string' } }
    },
    promptFn: (req) => `You are a professional subtitle translator. Translate the following subtitles:

${req || 'Please provide subtitle text and target language.'}

Rules:
- Keep each subtitle line under 42 characters where possible
- Preserve all timing/numbering information
- Use natural spoken language (not literary style)
- Split long translations across two lines if needed
- Maintain the original emotional tone and intent
- For cultural references, use the closest equivalent in target language
- Output in the same format as input (SRT or plain text)`
  },

  {
    category: 'translation',
    name: 'Technical Translation',
    name_zh: '技術文件翻譯',
    description: 'Specialized translation for technical documents: API docs, user manuals, patents, scientific papers, and engineering specs. Maintains precise terminology with a glossary of key terms.',
    price: 4.00,
    delivery_hours: 3,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Technical document content' },
        domain: { type: 'string', description: 'Technical domain (e.g., software, medical, legal, engineering)' },
        target_language: { type: 'string', description: 'Target language' }
      },
      required: ['document', 'target_language']
    },
    output_schema: {
      type: 'object',
      properties: { translation: { type: 'string' }, glossary: { type: 'object' } }
    },
    promptFn: (req) => `You are a specialized technical translator. Translate the following technical document:

${req || 'Please provide the document, domain, and target language.'}

Requirements:
- Maintain all technical terminology accuracy
- Keep code snippets, variable names, and commands untranslated
- Preserve document structure and formatting
- Create a terminology glossary (source → target) for key terms
- Flag any terms with ambiguous translations and provide alternatives
- Maintain consistency throughout the document

Output:
1. **Translated Document**
2. **Terminology Glossary** — Table of key terms with source and target
3. **Translator Notes** — Any ambiguities or decisions made`
  },

  // ═══════════════════════════════════════════════════════════════
  // DATA & ANALYTICS
  // ═══════════════════════════════════════════════════════════════
  {
    category: 'data',
    name: 'CSV Data Analysis',
    name_zh: 'CSV 資料分析',
    description: 'Paste your CSV data and get an instant analysis report. Includes statistical summary, trend identification, anomaly detection, and key insights. Supports sales data, survey results, financial data, and more.',
    price: 2.00,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'CSV data or description of your dataset' },
        question: { type: 'string', description: 'Specific question you want answered from the data' }
      },
      required: ['data']
    },
    output_schema: {
      type: 'object',
      properties: { summary: { type: 'object' }, insights: { type: 'array' }, recommendations: { type: 'array' } }
    },
    promptFn: (req) => `You are a data analyst. Analyze the following data:

${req || 'Please paste your CSV data or describe your dataset.'}

Provide:
1. **Data Overview** — Number of records, columns, data types, completeness
2. **Statistical Summary** — Key statistics (mean, median, min, max, std dev) for numeric columns
3. **Trend Analysis** — Any time-based trends or patterns
4. **Key Insights** — 3-5 most important findings
5. **Anomalies** — Any outliers or unusual data points
6. **Correlations** — Notable relationships between variables
7. **Recommendations** — 2-3 actionable next steps based on the data

Use clear formatting with tables where appropriate.`
  },

  {
    category: 'data',
    name: 'Survey Results Analysis',
    name_zh: '問卷調查分析',
    description: 'Transform raw survey responses into actionable insights. Analyzes response patterns, segments respondents, identifies key themes in open-ended answers, and delivers an executive summary with recommendations.',
    price: 3.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        survey_data: { type: 'string', description: 'Survey questions and response data' },
        objective: { type: 'string', description: 'What decisions will this survey inform?' }
      },
      required: ['survey_data']
    },
    output_schema: {
      type: 'object',
      properties: { executive_summary: { type: 'string' }, key_findings: { type: 'array' }, segments: { type: 'array' } }
    },
    promptFn: (req) => `You are a market research analyst. Analyze the following survey data:

${req || 'Please provide your survey questions and responses.'}

Deliver:
1. **Executive Summary** — 3-4 sentence overview of findings
2. **Response Overview** — Completion rate, demographics if available
3. **Quantitative Analysis** — Distribution of responses per question, averages, trends
4. **Qualitative Themes** — Key themes from open-ended responses (with example quotes)
5. **Respondent Segments** — Identify 2-3 distinct respondent groups
6. **Key Findings** — Top 5 insights ranked by importance
7. **Recommendations** — 3-4 actionable recommendations
8. **Limitations** — Note any caveats or data quality issues

Present findings in a clear, boardroom-ready format.`
  },

  {
    category: 'data',
    name: 'Competitor Analysis Report',
    name_zh: '競爭對手分析報告',
    description: 'Deep-dive competitive analysis for any company or product. Covers market positioning, pricing strategy, feature comparison, strengths/weaknesses, and strategic recommendations. Based on publicly available information.',
    price: 5.00,
    delivery_hours: 4,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Your company or product name' },
        competitors: { type: 'string', description: 'Competitor names (comma-separated)' },
        industry: { type: 'string', description: 'Industry or market segment' }
      },
      required: ['company']
    },
    output_schema: {
      type: 'object',
      properties: { competitive_landscape: { type: 'string' }, swot_per_competitor: { type: 'object' }, recommendations: { type: 'array' } }
    },
    promptFn: (req) => `You are a competitive intelligence analyst. Create a comprehensive competitor analysis for:

${req || 'Please provide your company name and key competitors.'}

Include:
1. **Market Landscape** — Overview of the competitive environment
2. **Competitor Profiles** — For each competitor:
   - Company overview and positioning
   - Key products/services
   - Pricing strategy
   - Target audience
   - Strengths and weaknesses
3. **Feature Comparison Matrix** — Key features side by side
4. **Pricing Comparison** — Price points and value proposition
5. **Market Share & Positioning** — Relative market positions
6. **Competitive Advantages** — Your differentiation opportunities
7. **Strategic Recommendations** — 4-5 actionable strategies

Base analysis on publicly available information. Be specific and strategic.`
  },

  {
    category: 'data',
    name: 'Market Trend Report',
    name_zh: '市場趨勢報告',
    description: 'Get a forward-looking market trend analysis for any industry. Covers emerging trends, growth drivers, disruption risks, and opportunity areas. Includes data points and expert-level commentary.',
    price: 4.00,
    delivery_hours: 3,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        industry: { type: 'string', description: 'Industry or market to analyze' },
        timeframe: { type: 'string', description: 'Trend timeframe (e.g., 2024-2025, next 5 years)' },
        region: { type: 'string', description: 'Geographic focus (global, US, Asia, etc.)' }
      },
      required: ['industry']
    },
    output_schema: {
      type: 'object',
      properties: { trends: { type: 'array' }, opportunities: { type: 'array' }, risks: { type: 'array' } }
    },
    promptFn: (req) => `You are a market research strategist. Write a market trend report for:

${req || 'Please specify the industry or market to analyze.'}

Include:
1. **Market Overview** — Current state, size, growth rate
2. **Top 5 Emerging Trends** — Each with evidence, timeline, and impact assessment
3. **Growth Drivers** — Key factors accelerating the market
4. **Disruption Risks** — Technologies or shifts that could reshape the market
5. **Consumer/Buyer Behavior Shifts** — How demand patterns are changing
6. **Opportunity Map** — 3-4 specific opportunity areas for new entrants or innovators
7. **Regional Variations** — Key differences across geographies
8. **Outlook & Predictions** — 12-month and 3-year outlook

Support claims with data points where possible. Professional consulting-quality output.`
  },

  {
    category: 'data',
    name: 'Weekly Analytics Digest',
    name_zh: '每週數據分析摘要',
    description: 'Subscribe to a weekly digest that analyzes your business KPIs. Provide your metrics and receive trend analysis, week-over-week comparisons, and actionable improvement suggestions every week.',
    price: 2.00,
    delivery_hours: 4,
    product_type: 'subscription',
    market_type: 'h2a',
    sub_interval: 'weekly',
    sub_price: 1.50,
    input_schema: {
      type: 'object',
      properties: {
        metrics: { type: 'string', description: 'Key metrics to track (e.g., revenue, users, churn rate)' },
        business_type: { type: 'string', description: 'Your business type for contextual analysis' }
      },
      required: ['metrics']
    },
    output_schema: {
      type: 'object',
      properties: { digest: { type: 'string' }, week: { type: 'string' } }
    },
    promptFn: (req) => `Generate a weekly analytics digest for the following business metrics:

${req || 'Please provide your key metrics and business type.'}

Format:
## Weekly Analytics Digest

**Performance Summary** — Overall health score (green/yellow/red)

**Key Metrics Overview** — Each metric with trend direction and context

**Week-over-Week Changes** — Notable improvements or declines

**Top Insight** — The single most important finding this week

**Opportunities** — 2-3 areas where data suggests room for improvement

**Action Items** — 3 specific, prioritized recommendations

**What to Watch Next Week** — Metrics or events to monitor

Keep it concise and actionable. Executive-friendly format.`
  },

  // ═══════════════════════════════════════════════════════════════
  // CODE & TECHNICAL
  // ═══════════════════════════════════════════════════════════════
  {
    category: 'code',
    name: 'Code Review & Feedback',
    name_zh: '程式碼審查',
    description: 'Submit your code for a thorough AI review. Covers bugs, security vulnerabilities, performance issues, code style, and best practices. Supports JavaScript, Python, TypeScript, Go, Rust, Java, and more.',
    price: 2.00,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code to review' },
        language: { type: 'string', description: 'Programming language' },
        context: { type: 'string', description: 'What does this code do? Any specific concerns?' }
      },
      required: ['code']
    },
    output_schema: {
      type: 'object',
      properties: { issues: { type: 'array' }, suggestions: { type: 'array' }, overall_grade: { type: 'string' } }
    },
    promptFn: (req) => `You are a senior software engineer performing a code review. Review the following code:

\`\`\`
${req || '// Please paste your code here'}
\`\`\`

Provide a structured review:

1. **Overall Grade** — A/B/C/D/F with 1-sentence summary
2. **Bugs & Errors** — Any logic errors, off-by-one, null pointer risks
3. **Security Issues** — SQL injection, XSS, auth flaws, secrets exposure
4. **Performance** — N+1 queries, unnecessary loops, memory leaks
5. **Code Quality** — Naming, structure, DRY violations, complexity
6. **Best Practices** — Language-specific idioms and conventions
7. **Refactored Version** — Show improved code for the most critical issues
8. **Recommendations** — Top 3 priority improvements

Be specific. Reference line numbers or function names where applicable.`
  },

  {
    category: 'code',
    name: 'Bug Analysis & Fix',
    name_zh: '程式錯誤分析與修復',
    description: 'Paste your buggy code and error message, and get a detailed root cause analysis with a working fix. Explains why the bug occurs and how to prevent similar issues. Faster than Stack Overflow.',
    price: 1.50,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code with the bug' },
        error: { type: 'string', description: 'Error message or unexpected behavior description' },
        language: { type: 'string', description: 'Programming language' }
      },
      required: ['code', 'error']
    },
    output_schema: {
      type: 'object',
      properties: { root_cause: { type: 'string' }, fix: { type: 'string' }, prevention: { type: 'string' } }
    },
    promptFn: (req) => `You are a debugging expert. Analyze this bug:

${req || 'Please provide the buggy code and error message.'}

Provide:
1. **Root Cause** — What exactly is causing this bug and why
2. **Step-by-Step Explanation** — Walk through the execution flow that leads to the error
3. **The Fix** — Corrected code with comments explaining changes
4. **Why It Works** — Explain why the fix resolves the issue
5. **Prevention** — How to avoid this class of bugs in the future
6. **Related Issues** — Any other potential issues spotted in the code

Be clear and educational. Show the exact fix, not just hints.`
  },

  {
    category: 'code',
    name: 'API Documentation Generator',
    name_zh: 'API 文件產生器',
    description: 'Generate professional API documentation from your code or endpoint descriptions. Outputs OpenAPI/Swagger-compatible docs with request/response examples, error codes, and authentication details.',
    price: 3.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        code_or_endpoints: { type: 'string', description: 'API code, route definitions, or endpoint descriptions' },
        framework: { type: 'string', description: 'Framework (Express, FastAPI, Django, etc.)' }
      },
      required: ['code_or_endpoints']
    },
    output_schema: {
      type: 'object',
      properties: { documentation: { type: 'string' }, openapi_spec: { type: 'object' } }
    },
    promptFn: (req) => `You are a technical writer specializing in API documentation. Generate comprehensive API docs for:

${req || 'Please provide your API code or endpoint descriptions.'}

Generate:
1. **Overview** — What this API does, base URL, versioning
2. **Authentication** — How to authenticate (inferred from code)
3. **Endpoints** — For each endpoint:
   - Method & Path
   - Description
   - Parameters (path, query, body) with types and required/optional
   - Request example (curl + JavaScript fetch)
   - Success response example with schema
   - Error response examples
   - Rate limiting notes
4. **Error Codes** — Standard error code table
5. **Quick Start** — Copy-paste example to get started

Format in clean Markdown. Be thorough and developer-friendly.`
  },

  {
    category: 'code',
    name: 'SQL Query Generator',
    name_zh: 'SQL 查詢產生器',
    description: 'Describe what data you need in plain English and get an optimized SQL query. Supports PostgreSQL, MySQL, SQLite, and SQL Server. Includes query explanation and performance tips.',
    price: 0.75,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'What data do you need? Describe in plain English.' },
        schema: { type: 'string', description: 'Your table schema or column names (optional)' },
        dialect: { type: 'string', enum: ['postgresql', 'mysql', 'sqlite', 'sqlserver'], description: 'SQL dialect' }
      },
      required: ['request']
    },
    output_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, explanation: { type: 'string' } }
    },
    promptFn: (req) => `You are a database expert. Generate an optimized SQL query for:

${req || 'Please describe what data you need.'}

Provide:
1. **The Query** — Clean, formatted SQL with comments
2. **Explanation** — Line-by-line breakdown of what the query does
3. **Performance Notes** — Suggested indexes, potential bottlenecks
4. **Variations** — Alternative approaches if applicable
5. **Sample Output** — What the result set might look like

Default to PostgreSQL unless specified. Use best practices: avoid SELECT *, use explicit JOINs, handle NULLs.`
  },

  {
    category: 'code',
    name: 'Regex Builder',
    name_zh: '正則表達式產生器',
    description: 'Describe what you want to match in plain English and get a tested regex pattern with explanation. Includes test cases, common edge cases, and variations for different regex flavors (JS, Python, PCRE).',
    price: 0.50,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What pattern do you want to match? Describe in plain English.' },
        flavor: { type: 'string', enum: ['javascript', 'python', 'pcre', 'go'], description: 'Regex flavor' },
        examples: { type: 'string', description: 'Example strings that should/should not match' }
      },
      required: ['description']
    },
    output_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, explanation: { type: 'string' }, test_cases: { type: 'array' } }
    },
    promptFn: (req) => `You are a regex expert. Build a regex pattern for:

${req || 'Please describe what pattern you want to match.'}

Provide:
1. **The Pattern** — Clean regex with flags
2. **Character-by-Character Explanation** — Break down each part
3. **Test Cases** — 5+ examples of strings that should match and 5+ that should not
4. **Edge Cases** — Common tricky inputs and how the regex handles them
5. **Flavors** — If the pattern differs between JavaScript/Python/PCRE, show each
6. **Usage Example** — Code snippet showing the regex in use

Keep the pattern as simple as possible while being accurate.`
  },

  // ═══════════════════════════════════════════════════════════════
  // DESIGN & CREATIVE
  // ═══════════════════════════════════════════════════════════════
  {
    category: 'design',
    name: 'UI/UX Design Review',
    name_zh: 'UI/UX 設計審查',
    description: 'Get expert UI/UX feedback on your app or website. Describe your interface or share screenshots, and receive a detailed critique covering usability, accessibility, visual hierarchy, and conversion optimization.',
    price: 3.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        interface_description: { type: 'string', description: 'Describe your UI or paste a screenshot URL' },
        platform: { type: 'string', enum: ['web', 'ios', 'android', 'desktop'], description: 'Target platform' },
        user_goal: { type: 'string', description: 'Primary user goal or conversion action' }
      },
      required: ['interface_description']
    },
    output_schema: {
      type: 'object',
      properties: { score: { type: 'number' }, issues: { type: 'array' }, recommendations: { type: 'array' } }
    },
    promptFn: (req) => `You are a senior UI/UX designer. Review the following interface:

${req || 'Please describe the UI you want reviewed.'}

Provide a comprehensive review:
1. **Overall UX Score** — 1-10 with summary
2. **Visual Hierarchy** — Is the most important content prominent?
3. **Usability** — Can users achieve their goal easily?
4. **Accessibility** — WCAG compliance concerns (contrast, font size, labels)
5. **Mobile Responsiveness** — How well does this adapt?
6. **Conversion Optimization** — Is the CTA clear and compelling?
7. **Top 5 Issues** — Ranked by severity with specific fix recommendations
8. **Quick Wins** — 3 changes that would have the biggest impact

Be specific and actionable. Reference specific elements in the interface.`
  },

  {
    category: 'design',
    name: 'Color Palette Generator',
    name_zh: '配色方案產生器',
    description: 'Generate a professional, harmonious color palette for your brand, website, or app. Includes primary, secondary, accent, neutral, and semantic colors with hex codes, usage guidelines, and accessibility ratios.',
    price: 1.00,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        brand_description: { type: 'string', description: 'Describe your brand personality and industry' },
        mood: { type: 'string', description: 'Desired mood (e.g., professional, playful, luxurious, minimal)' },
        base_color: { type: 'string', description: 'Starting color if you have one (hex code)' }
      },
      required: ['brand_description']
    },
    output_schema: {
      type: 'object',
      properties: { palette: { type: 'object' }, usage_guide: { type: 'string' } }
    },
    promptFn: (req) => `You are a color theory expert and brand designer. Create a color palette for:

${req || 'Please describe your brand and desired mood.'}

Generate:
1. **Primary Color** — Hex, RGB, HSL with rationale
2. **Secondary Color** — Complementary to primary
3. **Accent Color** — For CTAs and highlights
4. **Neutral Scale** — 5 shades from near-white to near-black
5. **Semantic Colors** — Success (green), Warning (yellow), Error (red), Info (blue)
6. **Dark Mode Variants** — Adjusted palette for dark backgrounds
7. **Accessibility Check** — WCAG AA contrast ratios for text on each background
8. **Usage Guidelines** — When to use each color
9. **CSS Variables** — Ready-to-use CSS custom properties

The palette should be cohesive, modern, and production-ready.`
  },

  {
    category: 'design',
    name: 'Brand Naming Generator',
    name_zh: '品牌命名產生器',
    description: 'Get 20+ creative brand name ideas with domain availability checks, linguistic analysis, and brand positioning rationale. Each name is evaluated for memorability, pronunciation, and global appeal.',
    price: 2.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        business_description: { type: 'string', description: 'What does your business do?' },
        values: { type: 'string', description: 'Core brand values or keywords' },
        style: { type: 'string', enum: ['modern', 'classic', 'playful', 'technical', 'premium'], description: 'Naming style' }
      },
      required: ['business_description']
    },
    output_schema: {
      type: 'object',
      properties: { names: { type: 'array' }, top_picks: { type: 'array' } }
    },
    promptFn: (req) => `You are a brand naming expert. Generate creative brand names for:

${req || 'Please describe your business.'}

Provide 20+ name ideas across these categories:
1. **Descriptive Names** (5) — Clearly communicate what you do
2. **Abstract/Invented Names** (5) — Unique coined words
3. **Metaphor Names** (5) — Evocative imagery
4. **Compound/Portmanteau Names** (5) — Blended words
5. **Acronym Names** (3) — Short, punchy abbreviations

For each name provide:
- The name
- Pronunciation guide
- Meaning/rationale (1 sentence)
- Likely .com domain availability (educated guess)
- Global friendliness score (1-5)

Then select your **Top 3 Picks** with detailed rationale for each.`
  },

  {
    category: 'design',
    name: 'Tagline & Slogan Generator',
    name_zh: '標語產生器',
    description: 'Create memorable taglines and slogans for your brand, product, or campaign. Get 15+ options across different styles (aspirational, functional, emotional, witty) with analysis of what makes each effective.',
    price: 1.00,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand or product name' },
        value_prop: { type: 'string', description: 'Core value proposition' },
        audience: { type: 'string', description: 'Target audience' }
      },
      required: ['brand']
    },
    output_schema: {
      type: 'object',
      properties: { taglines: { type: 'array' }, top_pick: { type: 'string' } }
    },
    promptFn: (req) => `You are a creative director at a top ad agency. Generate taglines for:

${req || 'Please provide brand name and value proposition.'}

Create 15+ taglines across styles:
1. **Aspirational** (3) — Inspire and elevate
2. **Functional** (3) — Communicate the benefit clearly
3. **Emotional** (3) — Connect on a feeling level
4. **Witty/Clever** (3) — Memorable wordplay
5. **Minimalist** (3) — Ultra-short, punchy

For each tagline:
- The tagline
- Style category
- Why it works (1 sentence)
- Best use case (website header, ad campaign, social bio, etc.)

Select a **Top 3** with detailed analysis of rhythm, memorability, and brand fit.`
  },

  {
    category: 'design',
    name: 'Logo Concept Brief',
    name_zh: 'Logo 概念設計簡報',
    description: 'Get a detailed logo design brief with 3-5 concept directions. Each includes style description, symbol suggestions, typography recommendations, and mood references. Perfect for briefing a designer or design tool.',
    price: 2.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        brand_name: { type: 'string', description: 'Brand name' },
        industry: { type: 'string', description: 'Industry or niche' },
        personality: { type: 'string', description: 'Brand personality keywords' }
      },
      required: ['brand_name']
    },
    output_schema: {
      type: 'object',
      properties: { concepts: { type: 'array' }, recommended: { type: 'string' } }
    },
    promptFn: (req) => `You are a brand identity designer. Create a logo concept brief for:

${req || 'Please provide brand name and industry.'}

Deliver 4 distinct concept directions:

For each concept:
1. **Concept Name** — A descriptive title
2. **Style** — Minimal, geometric, hand-drawn, etc.
3. **Symbol/Icon Description** — Detailed visual description
4. **Typography** — Specific font family recommendations (with Google Fonts alternatives)
5. **Color Direction** — 2-3 colors with hex codes
6. **Mood/References** — What brands/styles this is inspired by
7. **Best For** — When to choose this direction

Also include:
- **Technical Requirements** — File formats, sizes, variations needed
- **Recommended Direction** — Your top pick with rationale`
  },

  // ═══════════════════════════════════════════════════════════════
  // BUSINESS & STRATEGY
  // ═══════════════════════════════════════════════════════════════
  {
    category: 'business',
    name: 'SWOT Analysis',
    name_zh: 'SWOT 分析',
    description: 'Professional SWOT analysis for any business, product, or strategic initiative. Goes beyond basic bullet points to include strategic implications, cross-quadrant insights, and prioritized action items.',
    price: 2.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Company, product, or initiative to analyze' },
        context: { type: 'string', description: 'Industry, market position, or additional context' }
      },
      required: ['subject']
    },
    output_schema: {
      type: 'object',
      properties: { strengths: { type: 'array' }, weaknesses: { type: 'array' }, opportunities: { type: 'array' }, threats: { type: 'array' } }
    },
    promptFn: (req) => `You are a strategy consultant. Perform a comprehensive SWOT analysis for:

${req || 'Please specify the business or product to analyze.'}

Deliver:
1. **Strengths** (5-6) — Internal advantages, with evidence/reasoning
2. **Weaknesses** (5-6) — Internal challenges, with impact assessment
3. **Opportunities** (5-6) — External favorable factors, with potential value
4. **Threats** (5-6) — External risks, with likelihood and severity

Then provide:
5. **Cross-Quadrant Strategies:**
   - SO Strategies (use strengths to capture opportunities)
   - WO Strategies (overcome weaknesses via opportunities)
   - ST Strategies (use strengths to mitigate threats)
   - WT Strategies (minimize weaknesses, avoid threats)
6. **Priority Actions** — Top 5 strategic moves ranked by impact and feasibility

Format as a professional consulting deliverable.`
  },

  {
    category: 'business',
    name: 'Business Plan Executive Summary',
    name_zh: '商業計畫摘要',
    description: 'Generate a polished executive summary for your business plan. Covers problem, solution, market size, business model, traction, team, and financial projections. Investor-ready format.',
    price: 5.00,
    delivery_hours: 4,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        business_idea: { type: 'string', description: 'Describe your business idea' },
        target_market: { type: 'string', description: 'Who are your customers?' },
        revenue_model: { type: 'string', description: 'How do you make money?' },
        traction: { type: 'string', description: 'Any existing traction or milestones?' }
      },
      required: ['business_idea']
    },
    output_schema: {
      type: 'object',
      properties: { executive_summary: { type: 'string' }, financial_snapshot: { type: 'object' } }
    },
    promptFn: (req) => `You are a startup advisor who has reviewed thousands of pitch decks. Write a compelling executive summary for:

${req || 'Please describe your business idea.'}

Structure (2-3 pages):
1. **The Problem** — What pain point are you solving? (with market data)
2. **The Solution** — What you are building and why it is 10x better
3. **Market Opportunity** — TAM, SAM, SOM with reasoning
4. **Business Model** — Revenue streams, pricing, unit economics
5. **Competitive Landscape** — Key competitors and your differentiation
6. **Traction & Milestones** — What you have achieved so far
7. **Go-to-Market Strategy** — How you will acquire customers
8. **Team** — Key roles needed (or describe existing team)
9. **Financial Projections** — 3-year revenue projection (Year 1, 2, 3)
10. **The Ask** — What you need to execute (funding, partnerships, etc.)

Write in a compelling, confident tone. Be specific with numbers. Investor-ready quality.`
  },

  {
    category: 'business',
    name: 'Pitch Deck Outline',
    name_zh: '簡報大綱產生器',
    description: 'Get a complete pitch deck outline with slide-by-slide content, speaker notes, and design direction. Follows the proven 12-slide framework used by top VCs. Ready to drop into your presentation tool.',
    price: 3.00,
    delivery_hours: 3,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        startup_info: { type: 'string', description: 'Describe your startup/business' },
        audience: { type: 'string', enum: ['investors', 'customers', 'partners', 'internal'], description: 'Who is this pitch for?' },
        stage: { type: 'string', enum: ['pre-seed', 'seed', 'series-a', 'growth'], description: 'Company stage' }
      },
      required: ['startup_info']
    },
    output_schema: {
      type: 'object',
      properties: { slides: { type: 'array' }, speaker_notes: { type: 'array' } }
    },
    promptFn: (req) => `You are a pitch deck consultant. Create a complete pitch deck outline for:

${req || 'Please describe your startup.'}

For each slide (12 slides), provide:
- **Slide Title**
- **Key Message** (1 sentence the audience should remember)
- **Content** — Bullet points, data, or narrative
- **Visual Suggestion** — What graphic, chart, or image to use
- **Speaker Notes** — What to say (30-60 seconds per slide)
- **Design Tip** — Layout and emphasis suggestions

Follow this structure:
1. Title/Hook, 2. Problem, 3. Solution, 4. Demo/Product, 5. Market Size, 6. Business Model, 7. Traction, 8. Competition, 9. Go-to-Market, 10. Team, 11. Financials, 12. The Ask

Make it compelling and story-driven.`
  },

  {
    category: 'business',
    name: 'Meeting Minutes & Action Items',
    name_zh: '會議紀錄與待辦事項',
    description: 'Paste your meeting notes or transcript and get structured meeting minutes with clear action items, owners, and deadlines. Organized by topic with decision log and follow-up tracking.',
    price: 1.00,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        transcript: { type: 'string', description: 'Meeting notes or transcript' },
        meeting_type: { type: 'string', description: 'Type: standup, planning, review, brainstorm, all-hands' }
      },
      required: ['transcript']
    },
    output_schema: {
      type: 'object',
      properties: { minutes: { type: 'string' }, action_items: { type: 'array' }, decisions: { type: 'array' } }
    },
    promptFn: (req) => `You are an executive assistant. Transform these meeting notes into structured minutes:

${req || 'Please paste your meeting notes or transcript.'}

Format:
## Meeting Minutes

**Date:** [infer from context or leave blank]
**Attendees:** [extract from notes]
**Meeting Type:** [infer]

### Discussion Summary
- Organized by topic with key points

### Decisions Made
- [ ] Decision 1 — Context and rationale
- [ ] Decision 2 — Context and rationale

### Action Items
| # | Action | Owner | Deadline | Priority |
|---|--------|-------|----------|----------|
| 1 | ...    | ...   | ...      | High/Med/Low |

### Open Questions
- Items that need follow-up

### Next Meeting
- Suggested agenda items

Be concise. Extract every action item and decision. Use the exact names mentioned in the notes.`
  },

  {
    category: 'business',
    name: 'OKR Generator',
    name_zh: 'OKR 目標設定產生器',
    description: 'Generate well-structured OKRs (Objectives and Key Results) for your team or company. Each objective comes with measurable key results, initiatives, and alignment mapping. Follows Google/Intel OKR best practices.',
    price: 2.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team or company name' },
        goals: { type: 'string', description: 'High-level goals or strategic priorities' },
        timeframe: { type: 'string', enum: ['quarterly', 'annual'], description: 'OKR cycle' }
      },
      required: ['goals']
    },
    output_schema: {
      type: 'object',
      properties: { objectives: { type: 'array' }, alignment_map: { type: 'object' } }
    },
    promptFn: (req) => `You are an OKR coach. Generate well-structured OKRs for:

${req || 'Please describe your team goals.'}

Create 3-4 Objectives, each with 3-4 Key Results:

For each Objective:
- **Objective** — Qualitative, inspiring, ambitious
- **Key Results** — Quantitative, measurable, time-bound
  - KR format: "Increase/Decrease [metric] from [X] to [Y] by [date]"
- **Initiatives** — 2-3 specific projects or activities that drive the KRs
- **Confidence Level** — How ambitious is this? (50% = stretch, 70% = committed)
- **Dependencies** — What other teams or resources are needed?

Also provide:
- **Alignment Map** — How objectives connect to each other
- **Scoring Guide** — How to evaluate at end of quarter
- **Anti-Patterns** — Common mistakes to avoid with these OKRs

Follow Google OKR framework best practices.`
  },

  // ═══════════════════════════════════════════════════════════════
  // EDUCATION & LEARNING
  // ═══════════════════════════════════════════════════════════════
  {
    category: 'education',
    name: 'Lesson Plan Generator',
    name_zh: '教案產生器',
    description: 'Create a complete lesson plan for any subject and grade level. Includes learning objectives, activities, discussion questions, assessment rubric, and differentiation strategies. Aligned with common educational standards.',
    price: 2.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Lesson topic' },
        grade_level: { type: 'string', description: 'Grade level (e.g., K-2, 3-5, 6-8, 9-12, college)' },
        duration: { type: 'string', description: 'Class duration (e.g., 45 min, 90 min)' },
        standards: { type: 'string', description: 'Educational standards to align with (optional)' }
      },
      required: ['topic']
    },
    output_schema: {
      type: 'object',
      properties: { lesson_plan: { type: 'object' }, materials: { type: 'array' }, assessment: { type: 'object' } }
    },
    promptFn: (req) => `You are an experienced educator. Create a comprehensive lesson plan for:

${req || 'Please specify the topic and grade level.'}

Include:
1. **Overview** — Topic, grade level, duration, subject area
2. **Learning Objectives** — 3-4 measurable objectives (Bloom's taxonomy)
3. **Materials Needed** — List of required materials
4. **Warm-Up** (5-10 min) — Engaging opener/hook
5. **Direct Instruction** (15-20 min) — Key concepts with teaching notes
6. **Guided Practice** (10-15 min) — Interactive activity
7. **Independent Practice** (10-15 min) — Student activity
8. **Closure** (5 min) — Summary and reflection
9. **Assessment** — Formative and summative assessment ideas with rubric
10. **Differentiation** — Modifications for advanced, struggling, and ELL students
11. **Extension Activities** — Homework or enrichment options

Be practical and classroom-ready.`
  },

  {
    category: 'education',
    name: 'Quiz & Assessment Creator',
    name_zh: '測驗產生器',
    description: 'Generate a comprehensive quiz or assessment on any topic. Includes multiple choice, short answer, and essay questions at varying difficulty levels. Comes with an answer key, grading rubric, and learning objective mapping.',
    price: 1.50,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Quiz topic' },
        difficulty: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'], description: 'Difficulty level' },
        question_count: { type: 'number', description: 'Number of questions (default: 15)' },
        format: { type: 'string', enum: ['multiple-choice', 'mixed', 'short-answer', 'essay'], description: 'Question format' }
      },
      required: ['topic']
    },
    output_schema: {
      type: 'object',
      properties: { questions: { type: 'array' }, answer_key: { type: 'array' }, rubric: { type: 'object' } }
    },
    promptFn: (req) => `You are an assessment design expert. Create a quiz for:

${req || 'Please specify the topic and difficulty level.'}

Generate 15 questions (or as requested):
- **5 Multiple Choice** — 4 options each, varying difficulty
- **5 Short Answer** — Require 1-3 sentence responses
- **3 True/False** — With explanation required
- **2 Essay/Analysis** — Open-ended critical thinking

For each question:
- Question text
- Difficulty level (Easy/Medium/Hard)
- Learning objective it assesses
- Point value

Also provide:
- **Complete Answer Key** — With detailed explanations
- **Grading Rubric** — For short answer and essay questions
- **Total Points** — With grade scale (A/B/C/D/F)

Questions should test understanding, not just memorization.`
  },

  {
    category: 'education',
    name: 'Concept Explainer',
    name_zh: '概念解說',
    description: 'Get any complex concept explained clearly at your chosen level. Uses analogies, examples, and visual descriptions to make difficult ideas accessible. Works for science, math, technology, philosophy, and more.',
    price: 0.75,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        concept: { type: 'string', description: 'The concept to explain' },
        level: { type: 'string', enum: ['child', 'teenager', 'adult-beginner', 'college', 'expert'], description: 'Explanation level' },
        context: { type: 'string', description: 'Why do you need to understand this?' }
      },
      required: ['concept']
    },
    output_schema: {
      type: 'object',
      properties: { explanation: { type: 'string' }, analogy: { type: 'string' }, examples: { type: 'array' } }
    },
    promptFn: (req) => `You are a gifted teacher who can explain anything clearly. Explain:

"${req || 'Please specify the concept to explain.'}"

Provide:
1. **One-Sentence Summary** — The concept in the simplest possible terms
2. **The Analogy** — A relatable real-world analogy
3. **Full Explanation** — Clear, step-by-step explanation (avoid jargon, or define it)
4. **Real-World Examples** — 3 practical examples of this concept in action
5. **Common Misconceptions** — 2-3 things people often get wrong
6. **Visual Description** — Describe a diagram or visual that would help understanding
7. **Test Your Understanding** — 3 questions to check comprehension
8. **Learn More** — Suggested next topics to explore

Adapt to the audience level. Be engaging, not boring.`
  },

  {
    category: 'education',
    name: 'Study Guide Generator',
    name_zh: '學習指南產生器',
    description: 'Create a comprehensive study guide for any subject or exam. Includes key concepts, definitions, formulas, memory aids, practice questions, and a study schedule. Perfect for exam prep.',
    price: 2.00,
    delivery_hours: 2,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Subject or exam to prepare for' },
        topics: { type: 'string', description: 'Specific topics to cover (comma-separated)' },
        exam_date: { type: 'string', description: 'When is the exam? (for study schedule)' }
      },
      required: ['subject']
    },
    output_schema: {
      type: 'object',
      properties: { guide: { type: 'string' }, flashcards: { type: 'array' }, schedule: { type: 'object' } }
    },
    promptFn: (req) => `You are an expert tutor. Create a comprehensive study guide for:

${req || 'Please specify the subject or exam.'}

Include:
1. **Topic Overview** — Map of all key topics and subtopics
2. **Key Concepts** — Each concept with:
   - Definition (clear, concise)
   - Why it matters
   - How to remember it (mnemonic or memory aid)
3. **Important Formulas/Rules** — Quick reference table
4. **Flashcards** — 10 key Q&A pairs for quick review
5. **Practice Questions** — 10 questions with answers (varying difficulty)
6. **Common Exam Traps** — What the exam might try to trick you on
7. **Study Schedule** — Day-by-day plan (assuming 1 week to exam)
8. **Quick Review Sheet** — 1-page summary of the most critical points

Make it practical and student-friendly. Focus on what matters most for the exam.`
  },

  {
    category: 'education',
    name: 'Research Paper Summary',
    name_zh: '研究論文摘要',
    description: 'Paste any research paper or academic article and get a clear, structured summary. Covers methodology, key findings, limitations, and practical implications. Saves hours of academic reading.',
    price: 1.50,
    delivery_hours: 1,
    product_type: 'ai_generated',
    market_type: 'h2a',
    input_schema: {
      type: 'object',
      properties: {
        paper: { type: 'string', description: 'Paste the research paper text or abstract' },
        focus: { type: 'string', description: 'What aspect are you most interested in?' }
      },
      required: ['paper']
    },
    output_schema: {
      type: 'object',
      properties: { summary: { type: 'string' }, key_findings: { type: 'array' }, implications: { type: 'string' } }
    },
    promptFn: (req) => `You are a research analyst. Summarize the following academic paper:

${req || 'Please paste the research paper or abstract.'}

Provide:
1. **Citation** — Author(s), title, year (if identifiable)
2. **TL;DR** — 2-3 sentence plain-language summary
3. **Research Question** — What question does this paper address?
4. **Methodology** — How did they study this? (design, sample, methods)
5. **Key Findings** — 3-5 most important results
6. **Statistical Significance** — Key statistics and p-values if mentioned
7. **Limitations** — What the authors acknowledge or what you identify
8. **Practical Implications** — So what? Why does this matter?
9. **Related Questions** — What should be studied next?
10. **Critical Assessment** — Strengths and weaknesses of the study

Write for an educated non-specialist. Avoid unnecessary jargon.`
  },
];

// Utility: get all services for a given category slug
function getServicesByCategory(slug) {
  return SERVICES.filter(s => s.category === slug);
}

// Utility: get the agent definition for a category
function getAgentForCategory(slug) {
  return AGENTS.find(a => a.slug === slug);
}

module.exports = {
  CATEGORIES,
  AGENTS,
  SERVICES,
  getServicesByCategory,
  getAgentForCategory,
};
