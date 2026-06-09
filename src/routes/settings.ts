import { Router } from 'express';
import { db } from '../db.ts';
import { createId } from '@paralleldrive/cuid2';

const router = Router();

// GET /api/settings/options?category=shipping_line
router.get('/options', async (req, res) => {
  try {
    const { category } = req.query;
    let query = 'SELECT * FROM SettingOption WHERE isActive = 1';
    const params: any[] = [];
    
    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }
    
    query += ' ORDER BY label ASC';
    
    const options = await db.query<any>(query, params);
    return res.json({ data: options });
  } catch (error) {
    console.error('Settings options GET error:', error);
    return res.status(500).json({ error: 'Failed to fetch options' });
  }
});

// POST /api/settings/options
router.post('/options', async (req, res) => {
  try {
    const { category, value, label } = req.body;
    if (!category || !value || !label) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const id = createId();
    await db.execute(
      'INSERT INTO SettingOption (id, category, value, label) VALUES (?, ?, ?, ?)',
      [id, category, value, label]
    );
    
    const options = await db.query<any>('SELECT * FROM SettingOption WHERE id = ?', [id]);
    return res.status(201).json({ data: options[0] });
  } catch (error) {
    console.error('Settings options POST error:', error);
    return res.status(500).json({ error: 'Failed to create option' });
  }
});

// DELETE /api/settings/options/:id
router.delete('/options/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.execute('DELETE FROM SettingOption WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (error) {
    console.error('Settings options DELETE error:', error);
    return res.status(500).json({ error: 'Failed to delete option' });
  }
});

export default router;
