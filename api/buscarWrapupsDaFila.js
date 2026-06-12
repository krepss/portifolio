export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, queueId } = req.body;
  if (!token) return res.status(401).json({ erro: 'Token ausente.' });
  if (!queueId) return res.status(200).json([]); [cite: 27]

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');

  try {
    const response = await fetch(`${cleanUrl}/api/v2/routing/queues/${queueId}/wrapupcodes?pageSize=100`, { [cite: 28]
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    const data = await response.json();
    if (!response.ok) return res.status(200).json([]); [cite: 28]
    if (!data.entities) return res.status(200).json([]); [cite: 28]

    // Mapeia e retorna apenas o ID e o Nome amigável do código [cite: 29]
    const wrapups = data.entities.map(w => ({ id: w.id, nome: w.name })); [cite: 29]
    return res.status(200).json(wrapups);

  } catch (e) {
    return res.status(500).json({ erro: String(e) });
  }
}
