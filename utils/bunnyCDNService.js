const axios = require('axios');

/**
 * Bunny CDN Service for uploading and managing videos
 * Handles Zoom recording uploads to Bunny Stream
 */
class BunnyCDNService {
  constructor() {
    this.apiKey = process.env.BUNNY_API_KEY;
    this.libraryId = process.env.BUNNY_LIBRARY_ID;
    this.baseUrl = 'https://video.bunnycdn.com';
    // In-memory cache to track recently processed recording UUIDs (prevents duplicate uploads)
    this.processedRecordings = new Map(); // uuid -> { timestamp, bunnyVideoId }
    this.CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours TTL for cache
  }

  /**
   * Mark a recording UUID as processed
   * @param {String} recordingUuid - Zoom recording UUID
   * @param {String} bunnyVideoId - Bunny CDN video ID
   */
  markRecordingProcessed(recordingUuid, bunnyVideoId) {
    // Clean up old entries first
    this._cleanupCache();
    
    this.processedRecordings.set(recordingUuid, {
      timestamp: Date.now(),
      bunnyVideoId: bunnyVideoId,
    });
    console.log(`📝 Marked recording ${recordingUuid} as processed (Bunny ID: ${bunnyVideoId})`);
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
   * List all videos in the Bunny CDN library
   * @param {Number} page - Page number (1-indexed)
   * @param {Number} itemsPerPage - Items per page (max 100)
   * @param {String} search - Optional search term
   * @returns {Promise<Object>} List of videos with pagination info
   */
  async listVideos(page = 1, itemsPerPage = 100, search = '') {
    try {
      if (!this.isConfigured()) {
        throw new Error('Bunny CDN is not configured');
      }

      const params = new URLSearchParams({
        page: page.toString(),
        itemsPerPage: itemsPerPage.toString(),
      });

      if (search) {
        params.append('search', search);
      }

      const response = await axios.get(
        `${this.baseUrl}/library/${this.libraryId}/videos?${params.toString()}`,
        {
          headers: {
            AccessKey: this.apiKey,
          },
        }
      );

      return {
        videos: response.data.items || [],
        totalItems: response.data.totalItems || 0,
        currentPage: response.data.currentPage || page,
        itemsPerPage: response.data.itemsPerPage || itemsPerPage,
      };
    } catch (error) {
      console.error('❌ Error listing Bunny CDN videos:', error.response?.data || error.message);
      throw new Error(`Failed to list videos: ${error.response?.data?.Message || error.message}`);
    }
  }

  /**
   * Find existing video by title (exact or partial match)
   * @param {String} title - Video title to search for
   * @param {Boolean} exactMatch - Whether to require exact match
   * @returns {Promise<Object|null>} Video object if found, null otherwise
   */
  async findVideoByTitle(title, exactMatch = false) {
    try {
      if (!title) return null;

      // Search for videos with matching title
      const result = await this.listVideos(1, 100, title);
      
      if (!result.videos || result.videos.length === 0) {
        return null;
      }

      // Find exact or partial match
      for (const video of result.videos) {
        if (exactMatch) {
          if (video.title === title) {
            console.log(`🔍 Found exact match video: ${video.guid} (${video.title})`);
            return video;
          }
        } else {
          // Partial match - check if titles are similar
          if (video.title && video.title.toLowerCase().includes(title.toLowerCase())) {
            console.log(`🔍 Found partial match video: ${video.guid} (${video.title})`);
            return video;
          }
        }
      }

      return null;
    } catch (error) {
      console.error('❌ Error finding video by title:', error.message);
      return null;
    }
  }

  /**
   * Check if a video with similar title already exists (for deduplication)
   * This is used to prevent uploading the same recording multiple times
   * @param {String} zoomMeetingId - Zoom meeting ID
   * @param {String} recordingUuid - Zoom recording UUID (unique identifier)
   * @returns {Promise<Object|null>} Existing video info or null
   */
  async checkDuplicateRecording(zoomMeetingId, recordingUuid) {
    try {
      // First check in-memory cache (fastest)
      const cached = this.isRecordingProcessed(recordingUuid);
      if (cached) {
        console.log(`⏭️ Recording ${recordingUuid} already processed (from cache)`);
        return {
          isDuplicate: true,
          source: 'cache',
          bunnyVideoId: cached.bunnyVideoId,
        };
      }

      // Clean the UUID for search (remove special characters)
      const cleanUuid = recordingUuid.replace(/[^a-zA-Z0-9]/g, '');
      
      // Search in Bunny CDN by the UUID pattern in title or video ID
      const result = await this.listVideos(1, 100, zoomMeetingId);
      
      if (result.videos && result.videos.length > 0) {
        // Check for videos with matching Zoom meeting ID in title
        for (const video of result.videos) {
          // Check if this is the same recording (by comparing size, date, or title pattern)
          if (video.title && video.title.includes(`Recording ${zoomMeetingId}`)) {
            // Check if video has similar creation time (within 5 minutes)
            const videoDate = new Date(video.dateUploaded);
            const now = new Date();
            const timeDiff = Math.abs(now - videoDate);
            
            // If uploaded within the last hour with same meeting ID, likely a duplicate
            if (timeDiff < 60 * 60 * 1000) {
              console.log(`⚠️ Potential duplicate found: ${video.guid} (${video.title}), uploaded ${Math.round(timeDiff / 60000)} minutes ago`);
              return {
                isDuplicate: true,
                source: 'bunny_cdn',
                bunnyVideoId: video.guid,
                videoTitle: video.title,
                uploadedAt: video.dateUploaded,
              };
            }
          }
        }
      }

      return null;
    } catch (error) {
      console.error('❌ Error checking for duplicate recording:', error.message);
      // On error, return null to allow upload (fail open for recordings)
      return null;
    }
  }

  /**
   * Check if Bunny CDN is properly configured
   */
  isConfigured() {
    const configured = !!(this.apiKey && this.libraryId);
    if (!configured) {
      console.log('⚠️ Bunny CDN not configured:', {
        hasApiKey: !!this.apiKey,
        hasLibraryId: !!this.libraryId,
        libraryId: this.libraryId,
      });
    }
    return configured;
  }

  /**
   * Upload video buffer to Bunny CDN
   * @param {Buffer} videoBuffer - Video file buffer
   * @param {String} videoId - Unique video ID (will be used as video identifier)
   * @param {String} title - Video title (optional)
   * @returns {Promise<Object>} Upload response with video ID and URL
   */
  async uploadVideo(videoBuffer, videoId, title = 'Zoom Recording') {
    try {
      if (!this.isConfigured()) {
        throw new Error('Bunny CDN is not configured. Please set BUNNY_API_KEY and BUNNY_LIBRARY_ID environment variables.');
      }

      // Validate API key format (should not be empty)
      if (!this.apiKey || this.apiKey.trim().length === 0) {
        throw new Error('BUNNY_API_KEY is empty or invalid. Please check your environment variables.');
      }

      console.log(`📤 Starting upload to Bunny CDN: ${videoId}`);
      console.log(`📊 Video size: ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB`);
      console.log(`🔑 Using Library ID: ${this.libraryId}`);
      console.log(`🔑 API Key present: ${this.apiKey ? 'Yes (' + this.apiKey.substring(0, 8) + '...)' : 'No'}`);

      // Step 1: Create video in library
      const createUrl = `${this.baseUrl}/library/${this.libraryId}/videos`;
      console.log(`📝 Creating video in library: ${createUrl}`);
      
      const createResponse = await axios.post(
        createUrl,
        {
          title: title,
        },
        {
          headers: {
            AccessKey: this.apiKey,
            'Content-Type': 'application/json',
          },
        }
      );

      const bunnyVideoId = createResponse.data.guid || createResponse.data.videoLibraryId;
      
      if (!bunnyVideoId) {
        throw new Error('Failed to create video in Bunny CDN: No video ID returned');
      }

      console.log(`✅ Video created in Bunny CDN: ${bunnyVideoId}`);

      // Step 2: Upload video content
      await axios.put(
        `${this.baseUrl}/library/${this.libraryId}/videos/${bunnyVideoId}`,
        videoBuffer,
        {
          headers: {
            AccessKey: this.apiKey,
            'Content-Type': 'application/octet-stream',
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          // Increase timeout for large files (5 minutes)
          timeout: 300000,
          // Show upload progress
          onUploadProgress: (progressEvent) => {
            if (progressEvent.total) {
              const percentCompleted = Math.round(
                (progressEvent.loaded * 100) / progressEvent.total
              );
              if (percentCompleted % 10 === 0) {
                console.log(`📤 Upload progress: ${percentCompleted}%`);
              }
            }
          },
        }
      );

      console.log(`✅ Video uploaded successfully to Bunny CDN: ${bunnyVideoId}`);

      // Step 3: Get video details (including playback URL)
      const videoDetails = await this.getVideoDetails(bunnyVideoId);

      return {
        success: true,
        bunnyVideoId: bunnyVideoId,
        videoUrl: videoDetails.videoUrl || null,
        thumbnailUrl: videoDetails.thumbnailUrl || null,
        duration: videoDetails.duration || null,
      };
    } catch (error) {
      console.error('❌ Error uploading to Bunny CDN:', {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        config: {
          url: error.config?.url,
          method: error.config?.method,
          hasAccessKey: !!error.config?.headers?.AccessKey,
        },
      });
      
      // Provide helpful error messages based on status code
      if (error.response?.status === 401) {
        console.error('🔐 Authentication failed. Please check:');
        console.error('  1. BUNNY_API_KEY is set correctly in environment variables');
        console.error('  2. API key has proper permissions for video upload');
        console.error('  3. API key is not expired or revoked');
        console.error(`  4. Library ID (${this.libraryId}) is correct`);
      } else if (error.response?.status === 404) {
        console.error('🔍 Library not found. Please check:');
        console.error(`  1. Library ID (${this.libraryId}) is correct`);
        console.error('  2. Library exists in your Bunny CDN account');
      }
      
      // Clean up: Delete video if creation succeeded but upload failed
      if (error.response?.data?.guid) {
        try {
          await this.deleteVideo(error.response.data.guid);
        } catch (deleteError) {
          console.error('⚠️ Failed to cleanup video after upload error');
        }
      }

      const errorMessage = error.response?.data?.Message || 
                           error.response?.data?.message || 
                           error.message;
      
      throw new Error(`Failed to upload to Bunny CDN: ${errorMessage}`);
    }
  }

  /**
   * Get video details from Bunny CDN
   * @param {String} videoId - Bunny video ID
   * @returns {Promise<Object>} Video details
   */
  async getVideoDetails(videoId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/library/${this.libraryId}/videos/${videoId}`,
        {
          headers: {
            AccessKey: this.apiKey,
          },
        }
      );

      return {
        videoUrl: response.data.videoLibraryId 
          ? `https://vz-${this.libraryId}.b-cdn.net/${videoId}/play_720p.mp4`
          : null,
        thumbnailUrl: response.data.thumbnailFileName
          ? `https://vz-${this.libraryId}.b-cdn.net/${videoId}/${response.data.thumbnailFileName}`
          : null,
        duration: response.data.length || null,
        title: response.data.title || null,
        status: response.data.status || null,
      };
    } catch (error) {
      console.error('❌ Error getting video details:', error.response?.data || error.message);
      throw new Error(
        `Failed to get video details: ${error.response?.data?.Message || error.message}`
      );
    }
  }

  /**
   * Delete video from Bunny CDN
   * @param {String} videoId - Bunny video ID
   * @returns {Promise<Boolean>} Success status
   */
  async deleteVideo(videoId) {
    try {
      await axios.delete(
        `${this.baseUrl}/library/${this.libraryId}/videos/${videoId}`,
        {
          headers: {
            AccessKey: this.apiKey,
          },
        }
      );

      console.log(`✅ Video deleted from Bunny CDN: ${videoId}`);
      return true;
    } catch (error) {
      console.error('❌ Error deleting video:', error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Generate playback token for secure video access (optional)
   * @param {String} videoId - Bunny video ID
   * @param {Number} expirySeconds - Token expiry in seconds (default: 3600 = 1 hour)
   * @returns {String} Playback token
   */
  generatePlaybackToken(videoId, expirySeconds = 3600) {
    // This requires Bunny Stream token authentication setup
    // For now, returning null (public access)
    // You can implement token-based authentication if needed
    return null;
  }

  /**
   * Get video playback URL with optional token
   * @param {String} videoId - Bunny video ID
   * @param {Number} quality - Video quality (360, 480, 720, 1080, original)
   * @param {String} token - Optional playback token
   * @returns {String} Playback URL
   */
  getPlaybackUrl(videoId, quality = '720p', token = null) {
    const baseUrl = `https://vz-${this.libraryId}.b-cdn.net/${videoId}`;
    
    if (quality === 'original') {
      const url = `${baseUrl}/play.mp4`;
      return token ? `${url}?token=${token}` : url;
    }

    const url = `${baseUrl}/play_${quality}.mp4`;
    return token ? `${url}?token=${token}` : url;
  }

  /**
   * Generate Bunny CDN embed iframe code
   * @param {String} videoId - Bunny video ID
   * @param {Object} options - Embed options
   * @param {Boolean} options.autoplay - Autoplay video (default: true)
   * @param {Boolean} options.loop - Loop video (default: false)
   * @param {Boolean} options.muted - Mute video (default: false)
   * @param {Boolean} options.preload - Preload video (default: true)
   * @param {Boolean} options.responsive - Responsive embed (default: true)
   * @returns {String} HTML embed code
   */
  getEmbedCode(videoId, options = {}) {
    const {
      autoplay = true,
      loop = false,
      muted = false,
      preload = true,
      responsive = true,
    } = options;

    // Bunny CDN embed URL format: https://iframe.mediadelivery.net/embed/{libraryId}/{videoId}
    const embedUrl = `https://iframe.mediadelivery.net/embed/${this.libraryId}/${videoId}?autoplay=${autoplay}&loop=${loop}&muted=${muted}&preload=${preload}&responsive=${responsive}`;

    // Generate responsive embed iframe code
    const embedCode = `<div style="position:relative;padding-top:56.25%;"><iframe src="${embedUrl}" loading="lazy" style="border:0;position:absolute;top:0;height:100%;width:100%;" allow="accelerometer;gyroscope;autoplay;encrypted-media;picture-in-picture;" allowfullscreen="true"></iframe></div>`;

    return embedCode;
  }

  /**
   * Find and list duplicate videos in the library
   * Groups videos by similar titles (e.g., "Zoom Recording 83139293514")
   * @returns {Promise<Object>} Duplicate groups with video details
   */
  async findDuplicateVideos() {
    try {
      if (!this.isConfigured()) {
        throw new Error('Bunny CDN is not configured');
      }

      console.log('🔍 Scanning Bunny CDN library for duplicate videos...');
      
      // Fetch all videos (may need multiple pages for large libraries)
      let allVideos = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const result = await this.listVideos(page, 100);
        allVideos = allVideos.concat(result.videos);
        hasMore = result.videos.length === 100;
        page++;
        
        if (page > 50) {
          console.log('⚠️ Reached page limit, stopping at 5000 videos');
          break;
        }
      }

      console.log(`📊 Found ${allVideos.length} total videos in library`);

      // Group videos by title pattern (extract meeting ID from title)
      const groups = {};
      const zoomPattern = /Zoom Recording (\d+)/;

      for (const video of allVideos) {
        const match = video.title?.match(zoomPattern);
        if (match) {
          const meetingId = match[1];
          if (!groups[meetingId]) {
            groups[meetingId] = [];
          }
          groups[meetingId].push({
            guid: video.guid,
            title: video.title,
            dateUploaded: video.dateUploaded,
            length: video.length,
            storageSize: video.storageSize,
            status: video.status,
          });
        }
      }

      // Find duplicates (groups with more than 1 video)
      const duplicates = {};
      let duplicateCount = 0;

      for (const [meetingId, videos] of Object.entries(groups)) {
        if (videos.length > 1) {
          // Sort by upload date (keep the oldest one)
          videos.sort((a, b) => new Date(a.dateUploaded) - new Date(b.dateUploaded));
          duplicates[meetingId] = {
            keep: videos[0], // Keep the first (oldest) one
            remove: videos.slice(1), // Mark others for removal
            count: videos.length,
          };
          duplicateCount += videos.length - 1;
        }
      }

      console.log(`🔍 Found ${Object.keys(duplicates).length} meeting IDs with duplicates`);
      console.log(`📊 Total duplicate videos that can be removed: ${duplicateCount}`);

      return {
        totalVideos: allVideos.length,
        meetingsWithDuplicates: Object.keys(duplicates).length,
        duplicateVideosCount: duplicateCount,
        duplicates: duplicates,
      };
    } catch (error) {
      console.error('❌ Error finding duplicate videos:', error.message);
      throw error;
    }
  }

  /**
   * Remove duplicate videos from the library (keeps the oldest one)
   * @param {Boolean} dryRun - If true, only report what would be deleted without actually deleting
   * @returns {Promise<Object>} Cleanup results
   */
  async cleanupDuplicateVideos(dryRun = true) {
    try {
      const duplicateInfo = await this.findDuplicateVideos();
      
      if (duplicateInfo.duplicateVideosCount === 0) {
        console.log('✅ No duplicate videos found!');
        return { deleted: 0, failed: 0, skipped: 0 };
      }

      console.log(`\n${dryRun ? '🔍 DRY RUN - ' : '🗑️ '}Processing ${duplicateInfo.duplicateVideosCount} duplicate videos...`);

      let deleted = 0;
      let failed = 0;
      const results = [];

      for (const [meetingId, data] of Object.entries(duplicateInfo.duplicates)) {
        console.log(`\n📹 Meeting ${meetingId}: Keeping ${data.keep.guid} (${data.keep.title})`);
        
        for (const video of data.remove) {
          if (dryRun) {
            console.log(`  ⏭️ Would delete: ${video.guid} (${video.title}) - uploaded ${video.dateUploaded}`);
            results.push({ guid: video.guid, status: 'would_delete' });
          } else {
            try {
              await this.deleteVideo(video.guid);
              console.log(`  ✅ Deleted: ${video.guid} (${video.title})`);
              deleted++;
              results.push({ guid: video.guid, status: 'deleted' });
            } catch (deleteError) {
              console.error(`  ❌ Failed to delete: ${video.guid} - ${deleteError.message}`);
              failed++;
              results.push({ guid: video.guid, status: 'failed', error: deleteError.message });
            }
            
            // Add small delay between deletions to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
      }

      const summary = {
        totalDuplicates: duplicateInfo.duplicateVideosCount,
        deleted: deleted,
        failed: failed,
        dryRun: dryRun,
        results: results,
      };

      console.log(`\n📊 Cleanup Summary:`);
      console.log(`  - Total duplicates found: ${summary.totalDuplicates}`);
      console.log(`  - Deleted: ${summary.deleted}`);
      console.log(`  - Failed: ${summary.failed}`);
      console.log(`  - Dry run: ${summary.dryRun}`);

      return summary;
    } catch (error) {
      console.error('❌ Error cleaning up duplicate videos:', error.message);
      throw error;
    }
  }
}

module.exports = new BunnyCDNService();

