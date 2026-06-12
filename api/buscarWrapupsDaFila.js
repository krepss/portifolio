export default async function handler(req, res) {
  // Configuração de Headers para evitar qualquer bloqueio de requisição
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' });
  }

  const { token, baseUrl, queueId, idFila } = req.body;
  const targetQueueId = queueId || idFila;

  if (!token || !targetQueueId) {
    return res.status(200).json([]);
  }

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
    
    // Se o Genesys retornar algum erro ou não encontrar a propriedade entities, devolvemos um array vazio seguro []
    if (!response.ok || !data || !data.entities || !Array.isArray(data.entities)) {
      return res.status(200).json([]);
    }

    // Mapeia os dados exatamente como a função popularDropdown espera receber
    const wrapups = data.entities.map(w => ({
      id: w.id,
      nome: w.name || 'Sem nome'
    }));

    // Ordena alfabeticamente por nome para facilitar a busca do usuário
    wrapups.sort((a, b) => a.nome.localeCompare(b.nome));

    // RETORNO CRÍTICO: Devolve apenas a lista pura (Array), eliminando chaves extras
    return res.status(200).json(wrapups);

  } catch (e) {
    console.error('Erro interno na rota de wrapups:', e);
    return res.status(200).json([]);
  }
}
