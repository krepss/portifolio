export default async function handler(req, res) {
  // Habilita CORS para o frontend conseguir ler sem bloqueios
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' });
  }

  // Captura tanto se vier minúsculo (padrão Node) quanto se vier do padrão antigo (ex: idFila)
  const { token, baseUrl, queueId, idFila } = req.body;
  const targetQueueId = queueId || idFila;

  if (!token) return res.status(200).json({ erro: 'Token ausente.' });
  if (!targetQueueId) return res.status(200).json([]);

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');

  try {
    const response = await fetch(`${cleanUrl}/api/v2/routing/queues/${targetQueueId}/wrapupcodes?pageSize=100`, {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${token}`, 
        'Content-Type': 'application/json' 
      }
    });

    const data = await response.json();
    
    if (!response.ok || !data.entities) {
      // Se a fila não tiver wrapups associados diretamente, retorna lista vazia em vez de travar
      return res.status(200).json([]);
    }

    // Mapeia garantindo o formato de Objeto que o frontend usa para montar as <option>
    const wrapups = data.entities.map(w => ({
      id: w.id,
      nome: w.name || w.id
    }));

    // Ordena alfabeticamente para ficar bonito no select
    wrapups.sort((a, b) => a.nome.localeCompare(b.nome));

    return res.status(200).json(wrapups);

  } catch (e) {
    return res.status(200).json([]);
  }
}
