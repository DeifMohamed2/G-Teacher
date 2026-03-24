const { google } = require('googleapis');
const { Readable } = require('stream');

/**
 * YouTube Service for uploading videos
 * Handles Zoom recording uploads to YouTube via YouTube Data API v3
 * Requires OAuth2 user credentials (refresh token) - service accounts cannot upload to YouTube
 */
class YouTubeService {
  constructor() {
    this.clientId = process.env.YOUTUBE_CLIENT_ID;
    this.clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    this.refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
    this.defaultPrivacy = process.env.YOUTUBE_DEFAULT_PRIVACY || 'unlisted';
    // In-memory cache to track recently processed recording UUIDs (prevents duplicate uploads)
    this.processedRecordings = new Map(); // uuid -> { timestamp, youtubeVideoId }
    this.CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours TTL for cache
  }

  /**
   * Mark a recording UUID as processed
   * @param {String} recordingUuid - Zoom recording UUID
   * @param {String} youtubeVideoId - YouTube video ID
   */
  markRecordingProcessed(recordingUuid, youtubeVideoId) {
    this._cleanupCache();
    this.processedRecordings.set(recordingUuid, {
      timestamp: Date.now(),
      youtubeVideoId: youtubeVideoId,
    });
    console.log(`📝 Marked recording ${recordingUuid} as processed (YouTube ID: ${youtubeVideoId})`);
  }

  /**
   * Check if a recording UUID has already been processed
   * @param {String} recordingUuid - Zoom recording UUID
   * @returns {Object|null} Processing info if exists, null otherwise
   */
  isRecordingProcessed(recordingUuid) {
    this._cleanupCache();
    return this.processedRecordings.get(recordingUuid) || null;
  }

  /**
   * Clean up expired cache entries
   */
  _cleanupCache() {
    const now = Date.now();
    for (const [uuid, data] of this.processedRecordings) {
      if (now - data.timestamp > this.CACHE_TTL_MS) {
        this.processedRecordings.delete(uuid);
      }
    }
  }

  /**
   * Check if a video with similar title already exists (for deduplication)
   * @param {String} zoomMeetingId - Zoom meeting ID
   * @param {String} recordingUuid - Zoom recording UUID
   * @returns {Promise<Object|null>} Existing video info or null
   */
  async checkDuplicateRecording(zoomMeetingId, recordingUuid) {
    try {
      const cached = this.isRecordingProcessed(recordingUuid);
      if (cached) {
        console.log(`⏭️ Recording ${recordingUuid} already processed (from cache)`);
        return {
          isDuplicate: true,
          source: 'cache',
          youtubeVideoId: cached.youtubeVideoId,
        };
      }
      return null;
    } catch (error) {
      console.error('❌ Error checking for duplicate recording:', error.message);
      return null;
    }
  }

  /**
   * Check if YouTube is properly configured
   */
  isConfigured() {
    const configured = !!(this.clientId && this.clientSecret && this.refreshToken);
    if (!configured) {
      console.log('⚠️ YouTube not configured:', {
        hasClientId: !!this.clientId,
        hasClientSecret: !!this.clientSecret,
        hasRefreshToken: !!this.refreshToken,
      });
    }
    return configured;
  }

  /**
   * Get OAuth2 client for YouTube API
   * @returns {Promise<Object>} Authorized YouTube client
   */
  async getOAuth2Client() {
    const oauth2Client = new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3000/zoom/admin/youtube/oauth/callback'
    );

    oauth2Client.setCredentials({
      refresh_token: this.refreshToken,
    });

    return oauth2Client;
  }

  /**
   * Upload video buffer to YouTube
   * @param {Buffer} videoBuffer - Video file buffer
   * @param {String} title - Video title
   * @param {Object} options - Optional metadata
   * @param {String} options.meetingId - Zoom meeting ID (for description)
   * @param {String} options.recordingUuid - Recording UUID
   * @param {String} options.description - Video description
   * @param {String} options.privacyStatus - public, private, or unlisted
   * @returns {Promise<Object>} Upload response with video ID and URLs
   */
  async uploadVideo(videoBuffer, title, options = {}) {
    try {
      if (!this.isConfigured()) {
        throw new Error('YouTube is not configured. Please set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN.');
      }

      const privacyStatus = options.privacyStatus || this.defaultPrivacy;
      const description = options.description || `Zoom meeting recording${options.meetingId ? ` - Meeting ID: ${options.meetingId}` : ''}`;

      console.log(`📤 Starting upload to YouTube: ${title}`);
      console.log(`📊 Video size: ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB`);
      console.log(`🔒 Privacy: ${privacyStatus}`);

      const auth = await this.getOAuth2Client();
      const youtube = google.youtube({ version: 'v3', auth });

      // Convert Buffer to Readable stream for resumable upload support
      const videoStream = Readable.from(videoBuffer);
      const fileSize = videoBuffer.length;

      const res = await youtube.videos.insert(
        {
          part: 'id,snippet,status',
          notifySubscribers: false,
          requestBody: {
            snippet: {
              title: title,
              description: description,
              tags: ['zoom', 'recording', 'g-teacher'],
            },
            status: {
              privacyStatus: privacyStatus,
            },
          },
          media: {
            body: videoStream,
          },
        },
        {
          onUploadProgress: (evt) => {
            if (evt.bytesRead && fileSize > 0) {
              const percentCompleted = Math.round((evt.bytesRead / fileSize) * 100);
              if (percentCompleted % 10 === 0) {
                console.log(`📤 Upload progress: ${percentCompleted}%`);
              }
            }
          },
        }
      );

      const youtubeVideoId = res.data.id;
      const embedUrl = `https://www.youtube-nocookie.com/embed/${youtubeVideoId}`;
      const watchUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;

      console.log(`✅ Video uploaded successfully to YouTube: ${youtubeVideoId}`);

      return {
        success: true,
        youtubeVideoId: youtubeVideoId,
        embedUrl: embedUrl,
        watchUrl: watchUrl,
      };
    } catch (error) {
      console.error('❌ Error uploading to YouTube:', {
        message: error.message,
        code: error.code,
        response: error.response?.data,
      });

      // Provide helpful error messages
      if (error.code === 403) {
        if (error.response?.data?.error?.errors?.[0]?.reason === 'quotaExceeded') {
          console.error('🔍 YouTube API quota exceeded. Request quota increase in Google Cloud Console.');
        } else {
          console.error('🔍 Authentication or permission error. Check that your refresh token is valid.');
        }
      } else if (error.code === 401) {
        console.error('🔍 Token expired or invalid. Re-run OAuth flow to get a new refresh token.');
      }

      const errorMessage = error.response?.data?.error?.message || error.message;
      throw new Error(`Failed to upload to YouTube: ${errorMessage}`);
    }
  }

  /**
   * Generate YouTube embed URL
   * @param {String} videoId - YouTube video ID
   * @param {Object} options - Embed options
   * @returns {String} Embed URL
   */
  getEmbedUrl(videoId, options = {}) {
    const params = new URLSearchParams();
    if (options.autoplay) params.append('autoplay', '1');
    if (options.start) params.append('start', options.start);
    const query = params.toString();
    return `https://www.youtube-nocookie.com/embed/${videoId}${query ? '?' + query : ''}`;
  }
}

module.exports = new YouTubeService();
