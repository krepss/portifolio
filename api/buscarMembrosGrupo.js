export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });
  const { token, baseUrl, teamId } = req.body;
  if (!token || !teamId) return res.status(200).json([]);

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');

  try {
    const response = await fetch(`${cleanUrl}/api/v2/teams/${teamId}/members?pageSize=100&expand=user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    if (!response.ok || !data.entities) return res.status(200).json([]);

    // Retorna ID e Nome de cada operador do time
    const membros = data.entities.map(m => ({
      id: m.id,
      nome: m.name || (m.user ? m.user.name : 'Operador')
    }));
    
    membros.sort((a,b) => a.nome.localeCompare(b.nome));
    return res.status(200).json(membros);
  } catch {
    return res.status(200).json([]);
  }
}
