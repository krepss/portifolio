export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, queueId, wrapupId, intervaloIso, limite } = req.body;
  if (!token) return res.status(401).json({ erro: 'Token ausente.' });
  if (!queueId || !intervaloIso) return res.status(200).json({ erro: 'Parâmetros de busca incompletos.' }); [cite: 149, 150]

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');
  
  const predicates = [
    { "dimension": "queueId", "value": queueId }, [cite: 150]
    { "dimension": "mediaType", "value": "message" } [cite: 150]
  ];
  if (wrapupId) predicates.push({ "dimension": "wrapUpCode", "value": wrapupId }); [cite: 151]

  const payload = {
    "interval": intervaloIso, [cite: 151]
    "segmentFilters": [{ "type": "and", "predicates": predicates }], [cite: 151]
    "paging": { "pageSize": parseInt(limite) || 10, "pageNumber": 1 } [cite: 151, 152]
  };

  try {
    const response = await fetch(`${cleanUrl}/api/v2/analytics/conversations/details/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok || data.erro) return res.status(200).json({ erro: data.message || data.erro }); [cite: 152]
    
    const convs = data.conversations || []; [cite: 153]
    return res.status(200).json({ ok: true, ids: convs.map(c => c.conversationId) }); [cite: 153]

  } catch (e) {
    return res.status(500).json({ erro: String(e) });
  }
}
