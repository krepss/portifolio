export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, userId } = req.body;
  if (!token || !userId) return res.status(400).json({ erro: 'ID do agente não informado.' });

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    // 1. Busca o ID da presença "Offline"
    const resPres = await fetch(`${cleanUrl}/api/v2/presencedefinitions?pageSize=100`, { headers });
    const rPresencas = await resPres.json();
    if (!resPres.ok) return res.status(200).json({ ok: false, erro: 'Falha ao listar presenças: ' + rPresencas.message });

    let offlineId = null;
    (rPresencas.entities || []).forEach(p => {
      if (p.systemPresence && p.systemPresence.toUpperCase() === 'OFFLINE') offlineId = p.id;
    });

    if (!offlineId) return res.status(200).json({ ok: false, erro: 'Definição "Offline" não encontrada.' });

    // 2. PATCH para forçar o agente como Offline
    const resPatch = await fetch(`${cleanUrl}/api/v2/users/${userId}/presences/PURECLOUD`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ presenceDefinition: { id: offlineId } })
    });
    
    const rPatch = await resPatch.json();
    if (!resPatch.ok) return res.status(200).json({ ok: false, erro: 'Falha ao alterar presença: ' + rPatch.message });

    const novoStatus = (rPatch.presenceDefinition && rPatch.presenceDefinition.systemPresence) || 'Offline';
    return res.status(200).json({ ok: true, novoStatus });

  } catch (e) {
    return res.status(500).json({ ok: false, erro: String(e) });
  }
}
