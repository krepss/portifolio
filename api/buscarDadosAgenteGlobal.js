export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, userId, intervaloIso } = req.body;
  if (!token || !userId || !intervaloIso) return res.status(400).json({ erro: 'Parâmetros inválidos.' });

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');

  const payloadAgg = {
    "interval": intervaloIso,
    "groupBy": ["userId", "mediaType"],
    "filter": { "type": "and", "predicates": [ { "type": "dimension", "dimension": "userId", "value": userId } ] },
    "metrics": ["tHandle", "tAcw", "tHeld", "nTransferred"]
  };

  try {
    const response = await fetch(`${cleanUrl}/api/v2/analytics/conversations/aggregates/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadAgg)
    });

    const rAgg = await response.json();
    if (!response.ok) return res.status(200).json({ erro: rAgg.message || `HTTP ${response.status}` });

    let handCnt = 0, handVoice = 0, handDigital = 0, handSum = 0, acwSum = 0, heldSum = 0, trans = 0;

    if (rAgg.results) {
      rAgg.results.forEach(resGrp => {
        let mType = resGrp.group && resGrp.group.mediaType;
        if (resGrp.data) {
          resGrp.data.forEach(d => {
            if (d.metrics) {
              d.metrics.forEach(m => {
                if (m.metric === "tHandle") {
                  let count = m.stats.count || 0; handCnt += count; handSum += m.stats.sum || 0;
                  if (mType === 'voice' || mType === 'callback') handVoice += count; else handDigital += count;
                }
                if (m.metric === "tAcw") acwSum += m.stats.sum || 0;
                if (m.metric === "tHeld") heldSum += m.stats.sum || 0;
                if (m.metric === "nTransferred") trans += m.stats.count || 0;
              });
            }
          });
        }
      });
    }

    let aht = handCnt > 0 ? Math.round(handSum / handCnt / 1000) : 0;
    let acwMedio = handCnt > 0 ? Math.round(acwSum / handCnt / 1000) : 0;
    let tmeMedio = handCnt > 0 ? Math.round(heldSum / handCnt / 1000) : 0;

    return res.status(200).json({
      ok: true,
      kpis: { atendidas: handCnt, atendidasVoice: handVoice, atendidasDigital: handDigital, aht, acwMedio, tmeMedio, transferencias: trans }
    });

  } catch (e) {
    return res.status(500).json({ erro: String(e) });
  }
}
