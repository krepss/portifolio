export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });
  
  const { token, baseUrl } = req.body;
  if (!token) return res.status(401).json({ erro: 'Token ausente.' });

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');

  try {
    const response = await fetch(`${cleanUrl}/api/v2/teams?pageSize=100`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    
    const data = await response.json();
    if (!response.ok) return res.status(200).json({ erro: data.message || `HTTP ${response.status}` });
    if (!data.entities) return res.status(200).json([]);

    const equipes = data.entities.map(t => ({ id: t.id, nome: t.name }));
    return res.status(200).json(equipes);
  } catch (e) {
    return res.status(500).json({ erro: 'Falha no servidor: ' + String(e) });
  }
}
