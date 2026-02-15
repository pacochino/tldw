# tldw
tLDw is a lightweight browser extension that summarizes YouTube videos so you don't have to watch the whole thing. It reads the video transcript and uses AI to give you a concise summary with timestamps. Great for podcasts, long-form content, and clickbait.


Setup

To keep this extension free, you use your own Gemini API key (also free). Follow these steps:

    Go to Google AI Studio
    Sign in with your Google account
    Click "Create API Key"
    Copy the key and paste it below


Speed & How It Works

tLDw works by reading the video transcript and sending it to Gemini for summarization. Speed depends on where you click:

    On the video page — ~10 seconds. The transcript is scraped directly from the page. This is the fastest method.
    From the homepage or sidebar — ~20 seconds. tLDw must briefly open the video in a background tab to extract the transcript. You'll see the tab flash twice — this is required because   YouTube only renders transcript data when a tab has focus. This is the fastest approach possible while keeping the tool free and privacy-respecting.

For comparison, YouTube's built-in Gemini "Ask" feature takes about 8 seconds but requires two clicks and a scroll. tLDw trades a few extra seconds for a single-click experience.

Speed is constrained by YouTube's transcript rendering requirements and Gemini's free-tier API response times. The elapsed timer on the loading bar shows real-time progress so you always know where things stand.
