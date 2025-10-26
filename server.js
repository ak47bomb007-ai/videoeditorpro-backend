// Video Processing Backend for VideoEditorPro
// Deploy this on Railway.app or Render.com (both free)

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${uuidv4()}-${file.originalname}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

// Store processing jobs
const jobs = new Map();

// Middleware
app.use(express.json());
app.use('/output', express.static('output'));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'VideoEditorPro Backend' });
});

// Upload endpoint
app.post('/api/upload', upload.single('video'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        res.json({
            success: true,
            fileId: path.basename(req.file.path),
            filename: req.file.filename,
            size: req.file.size
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Process videos endpoint
app.post('/api/process', (req, res) => {
    const { video1Id, video2Id, layout, settings } = req.body;
    
    if (!video1Id || !video2Id) {
        return res.status(400).json({ error: 'Missing video IDs' });
    }

    const jobId = uuidv4();
    const video1Path = path.join('./uploads', video1Id);
    const video2Path = path.join('./uploads', video2Id);
    const outputDir = './output';
    const outputPath = path.join(outputDir, `${jobId}.mp4`);

    // Create output directory
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Initialize job
    jobs.set(jobId, {
        status: 'processing',
        progress: 0,
        startTime: Date.now()
    });

    // Process videos based on layout
    processVideos(video1Path, video2Path, outputPath, layout, settings, jobId)
        .then(() => {
            jobs.set(jobId, {
                status: 'completed',
                progress: 100,
                outputUrl: `/output/${jobId}.mp4`,
                completedTime: Date.now()
            });
        })
        .catch((error) => {
            console.error('Processing error:', error);
            jobs.set(jobId, {
                status: 'failed',
                error: error.message,
                failedTime: Date.now()
            });
        });

    res.json({
        success: true,
        jobId: jobId,
        message: 'Processing started'
    });
});

// Check job status
app.get('/api/jobs/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);
});

// Download processed video
app.get('/api/download/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job || job.status !== 'completed') {
        return res.status(404).json({ error: 'Video not ready' });
    }

    const filePath = path.join('./output', `${jobId}.mp4`);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath);
});

// Process videos function
async function processVideos(video1Path, video2Path, outputPath, layout, settings, jobId) {
    return new Promise((resolve, reject) => {
        let filterComplex = '';

        // Apply settings to each video
        const video1Settings = settings?.video1 || {};
        const video2Settings = settings?.video2 || {};

        switch (layout?.toLowerCase()) {
            case 'side by side':
                // Side by side layout
                filterComplex = `
                    [0:v]scale=960:1080,setsar=1[v1];
                    [1:v]scale=960:1080,setsar=1[v2];
                    [v1][v2]hstack=inputs=2[outv];
                    [0:a][1:a]amix=inputs=2:duration=longest[outa]
                `;
                break;

            case 'stacked':
                // Stacked (vertical) layout
                filterComplex = `
                    [0:v]scale=1920:540,setsar=1[v1];
                    [1:v]scale=1920:540,setsar=1[v2];
                    [v1][v2]vstack=inputs=2[outv];
                    [0:a][1:a]amix=inputs=2:duration=longest[outa]
                `;
                break;

            default:
                // Sequential (one after another)
                filterComplex = `
                    [0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]
                `;
        }

        const command = ffmpeg();
        
        command
            .input(video1Path)
            .input(video2Path)
            .complexFilter(filterComplex.trim())
            .map('[outv]')
            .map('[outa]')
            .videoCodec('libx264')
            .audioCodec('aac')
            .audioBitrate('128k')
            .videoBitrate('4000k')
            .outputOptions([
                '-preset fast',
                '-crf 23',
                '-movflags +faststart'
            ])
            .output(outputPath)
            .on('start', (commandLine) => {
                console.log('FFmpeg command:', commandLine);
            })
            .on('progress', (progress) => {
                const percent = Math.round(progress.percent || 0);
                const job = jobs.get(jobId);
                if (job) {
                    job.progress = percent;
                }
                console.log(`Processing: ${percent}% done`);
            })
            .on('end', () => {
                console.log('Processing finished successfully');
                
                // Clean up input files after 1 hour
                setTimeout(() => {
                    try {
                        if (fs.existsSync(video1Path)) fs.unlinkSync(video1Path);
                        if (fs.existsSync(video2Path)) fs.unlinkSync(video2Path);
                    } catch (err) {
                        console.error('Cleanup error:', err);
                    }
                }, 3600000);
                
                resolve();
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err);
                reject(err);
            })
            .run();
    });
}

// Cleanup old files every hour
setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    // Clean up old jobs
    jobs.forEach((job, jobId) => {
        const age = now - (job.completedTime || job.failedTime || job.startTime);
        if (age > maxAge) {
            jobs.delete(jobId);
            
            // Delete output file
            const outputPath = path.join('./output', `${jobId}.mp4`);
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
            }
        }
    });

    // Clean up old uploads
    ['uploads', 'output'].forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.readdirSync(dir).forEach(file => {
                const filePath = path.join(dir, file);
                const stats = fs.statSync(filePath);
                const age = now - stats.mtimeMs;
                
                if (age > maxAge) {
                    fs.unlinkSync(filePath);
                    console.log(`Deleted old file: ${file}`);
                }
            });
        }
    });
}, 3600000); // Run every hour

// Start server
app.listen(PORT, () => {
    console.log(`🚀 VideoEditorPro Backend running on port ${PORT}`);
    console.log(`📍 Upload endpoint: http://localhost:${PORT}/api/upload`);
    console.log(`📍 Process endpoint: http://localhost:${PORT}/api/process`);
});

// Handle shutdown gracefully
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});
