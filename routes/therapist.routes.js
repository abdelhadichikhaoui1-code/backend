// ...existing code...

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const Patient = require('../models/Patient');
const Session = require('../models/Session');
const PatientSession = require('../models/PatientSession');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { initGridFS } = require('../models/gridfs');
const mongoose = require('mongoose');
const { isValidObjectId } = mongoose;
const { ObjectId } = require('mongodb');

function extractVideoId(videoPath = '') {
  const match = String(videoPath).match(/\/api\/therapist\/video\/([a-fA-F0-9]{24})$/);
  return match ? match[1] : null;
}

function collectVideoIds(exercises = []) {
  return exercises
    .map(ex => extractVideoId(ex.videoPath))
    .filter(Boolean);
}

async function deleteGridFsFileById(fileId) {
  try {
    const gfs = initGridFS(mongoose.connection);
    await gfs.delete(new ObjectId(fileId));
  } catch (e) {
    // Ignore missing/corrupt file ids to avoid blocking delete flow.
  }
}

// Route pour servir une vidéo depuis GridFS
router.get('/video/:id', async (req, res) => {
  try {
    const gfs = initGridFS(mongoose.connection);
    const { ObjectId } = require('mongodb');
    const fileId = new ObjectId(req.params.id);
    const files = await mongoose.connection.db.collection('videos.files').find({ _id: fileId }).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ message: 'Vidéo non trouvée' });
    }
    res.set('Content-Type', files[0].contentType || 'video/mp4');
    const downloadStream = gfs.openDownloadStream(fileId);
    downloadStream.pipe(res);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

router.use(auth(['therapist']));

router.get('/patients', async (req, res) => {
  try {
    const patients = await Patient.find().select('-password').lean();
    const PatientSession = require('../models/PatientSession');
    
    // Add completedSession count for each patient
    const enrichedPatients = await Promise.all(patients.map(async (p) => {
      const completedCount = await PatientSession.countDocuments({ patientId: p._id, status: 'completed' });
      return { ...p, completedCount };
    }));

    res.json(enrichedPatients);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// Route de création de séance pour TOUS les patients (pas de patientId)
router.post('/sessions', upload.any(), async (req, res) => {
  try {
    const { title, exercisesData } = req.body;
    const cleanTitle = String(title ?? '').trim();
    if (!cleanTitle) {
      return res.status(400).json({ message: 'Le titre de la séance est obligatoire.' });
    }

    let exercises = [];
    if (exercisesData) {
      try {
        exercises = JSON.parse(exercisesData);
      } catch (e) {
        return res.status(400).json({ message: 'Format des exercices invalide.' });
      }
    }
    if (!Array.isArray(exercises) || exercises.length === 0) {
      return res.status(400).json({ message: 'Ajoutez au moins un exercice.' });
    }

    // Init GridFS bucket
    const gfs = initGridFS(mongoose.connection);

    // Upload videos to GridFS and get their ids
    const exercisePromises = exercises.map(async (ex, i) => {
      const cleanExerciseTitle = String(ex.title ?? '').trim();
      const duration = Number(ex.duration);
      const repetitions = Number(ex.repetitions || 1);
      if (!cleanExerciseTitle || !Number.isFinite(duration) || duration <= 0) {
        throw new Error('INVALID_EXERCISE_PAYLOAD');
      }

      const file = req.files.find(f => f.fieldname === `video_${i}`);
      let videoId = null;
      if (file) {
        // Store in GridFS
        const uploadStream = gfs.openUploadStream(file.originalname, {
          contentType: file.mimetype
        });
        uploadStream.end(file.buffer);
        await new Promise((resolve, reject) => {
          uploadStream.on('finish', resolve);
          uploadStream.on('error', reject);
        });
        videoId = uploadStream.id;
      }
      return {
        title: cleanExerciseTitle,
        description: ex.description,
        duration,
        repetitions: Number.isFinite(repetitions) && repetitions > 0 ? repetitions : 1,
        videoPath: videoId ? `/api/therapist/video/${videoId}` : (ex.videoPath || ex.videoUrl || '')
      };
    });

    const exercisesWithVideos = await Promise.all(exercisePromises);

    const newSession = new Session({
      therapistId: req.user.userId,
      title: cleanTitle,
      exercises: exercisesWithVideos
    });

    await newSession.save();
    res.status(201).json(newSession);
  } catch (err) {
    if (err.message === 'INVALID_EXERCISE_PAYLOAD') {
      return res.status(400).json({ message: "Chaque exercice doit avoir un titre et une durée valide." });
    }
    if (`${err?.message || ''}`.toLowerCase().includes('space quota')) {
      return res.status(507).json({ message: 'Stockage sature. Supprimez des programmes/videos puis reessayez.' });
    }
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// Récupérer les séances globales (créées par ce thérapeute)
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await Session.find({ therapistId: req.user.userId });
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// Supprimer une séance
router.delete('/sessions/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Identifiant de séance invalide.' });
    }
    const session = await Session.findOneAndDelete({ _id: req.params.id, therapistId: req.user.userId });
    if (!session) return res.status(404).json({ message: 'Séance non trouvée' });

    const videoIds = collectVideoIds(session.exercises);
    await Promise.all(videoIds.map(deleteGridFsFileById));
    await PatientSession.deleteMany({ sessionId: session._id });

    res.json({ message: 'Séance supprimée' });
  } catch (err) {
    console.error('DELETE /therapist/sessions/:id failed:', err);
    if (`${err?.message || ''}`.toLowerCase().includes('space quota')) {
      return res.status(507).json({ message: 'Stockage sature. La suppression est bloquee par Mongo Atlas tant que le quota est depasse.' });
    }
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// Modifier une séance (Metadata + Exercices)
router.put('/sessions/:id', upload.any(), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Identifiant de séance invalide.' });
    }

    const { title, exercisesData } = req.body;
    const cleanTitle = String(title ?? '').trim();
    if (!cleanTitle) {
      return res.status(400).json({ message: 'Le titre de la séance est obligatoire.' });
    }

    let exercises = [];
    if (exercisesData) {
      try {
        exercises = JSON.parse(exercisesData);
      } catch (e) {
        return res.status(400).json({ message: 'Format des exercices invalide.' });
      }
    }
    if (!Array.isArray(exercises) || exercises.length === 0) {
      return res.status(400).json({ message: 'Ajoutez au moins un exercice.' });
    }

    const currentSession = await Session.findOne({ _id: req.params.id, therapistId: req.user.userId });
    if (!currentSession) return res.status(404).json({ message: 'Séance non trouvée' });

    const gfs = initGridFS(mongoose.connection);

    const exercisePromises = exercises.map(async (ex, i) => {
      const cleanExerciseTitle = String(ex.title ?? '').trim();
      const duration = Number(ex.duration);
      const repetitions = Number(ex.repetitions || 1);
      if (!cleanExerciseTitle || !Number.isFinite(duration) || duration <= 0) {
        throw new Error('INVALID_EXERCISE_PAYLOAD');
      }

      const file = req.files.find(f => f.fieldname === `video_${i}`);
      let videoId = null;
      if (file) {
        const uploadStream = gfs.openUploadStream(file.originalname, {
          contentType: file.mimetype
        });
        uploadStream.end(file.buffer);
        await new Promise((resolve, reject) => {
          uploadStream.on('finish', resolve);
          uploadStream.on('error', reject);
        });
        videoId = uploadStream.id;
      }
      return {
        title: cleanExerciseTitle,
        description: ex.description,
        duration,
        repetitions: Number.isFinite(repetitions) && repetitions > 0 ? repetitions : 1,
        videoPath: videoId ? `/api/therapist/video/${videoId}` : (ex.videoPath || ex.videoUrl || '')
      };
    });

    const exercisesWithVideos = await Promise.all(exercisePromises);

    const updatedSession = await Session.findOneAndUpdate(
      { _id: req.params.id, therapistId: req.user.userId },
      {
        title: cleanTitle,
        exercises: exercisesWithVideos
      },
      { new: true }
    );

    const oldIds = collectVideoIds(currentSession.exercises);
    const keptOrNewIds = new Set(collectVideoIds(exercisesWithVideos));
    const removedIds = oldIds.filter(id => !keptOrNewIds.has(id));
    await Promise.all(removedIds.map(deleteGridFsFileById));

    res.json(updatedSession);
  } catch (err) {
    if (err.message === 'INVALID_EXERCISE_PAYLOAD') {
      return res.status(400).json({ message: "Chaque exercice doit avoir un titre et une durée valide." });
    }
    if (`${err?.message || ''}`.toLowerCase().includes('space quota')) {
      return res.status(507).json({ message: 'Stockage sature. Supprimez des programmes/videos puis reessayez.' });
    }
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

module.exports = router;
