export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });
  
  const { token, baseUrl } = req.body;
  if (!token) return res.status(401).json({ erro: 'Token ausente.' });

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');
  const filas = [];

  try {
    // Busca até 10 páginas de filas (como no seu GAS original)
    for (let p = 1; p <= 10; p++) {
      const response = await fetch(`${cleanUrl}/api/v2/routing/queues?pageSize=100&pageNumber=${p}&sortBy=name&sortOrder=asc`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      
      const data = await response.json();
      if (!response.ok) return res.status(200).json({ erro: data.message || `HTTP ${response.status}` });
      if (!data.entities || !data.entities.length) break;

      data.entities.forEach(q => filas.push({ id: q.id, nome: q.name, membros: q.memberCount || 0 }));
      if (data.pageCount && p >= data.pageCount) break;
    }
    
    return res.status(200).json({ filas });
  } catch (e) {
    return res.status(500).json({ erro: 'Falha no servidor: ' + String(e) });
  }
}
