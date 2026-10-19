import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

// Helper: build a store seeded with N contracts for bulk tests.
function seededStore(n: number): EscrowStore {
  const s = new EscrowStore();
  for (let i = 0; i < n; i++) {
    s.create({
      title: `Engagement ${i}`,
      client: `GC${i.toString().padStart(5, '0')}`,
      freelancer: `GF${i.toString().padStart(5, '0')}`,
      milestones: Array.from({ length: 5 }, (_, j) => ({ title: `M${j}`, amount: 100 + j })),
    });
  }
  return s;
}

describe('TalentTrust API', () => {
  const app = createApp(new EscrowStore());

  it('serves health and root', async () => {
    const h = await request(app).get('/health');
    expect(h.status).toBe(200);
    expect(h.body.status).toBe('ok');
    const root = await request(app).get('/');
    expect(root.status).toBe(200);
    expect(root.body.endpoints.length).toBeGreaterThan(5);
  });

  it('serves docs and openapi', async () => {
    expect((await request(app).get('/docs')).status).toBe(200);
    const spec = await request(app).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
  });

  it('runs the escrow lifecycle', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }, { amount: 50 }] });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 150 })).body.status).toBe(
      'Funded',
    );
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    const done = await request(app).post(`/api/v1/contracts/${id}/milestones/1/release`).expect(200);
    expect(done.body.status).toBe('Completed');
    const rep = await request(app).post(`/api/v1/contracts/${id}/reputation`).send({ rating: 4 }).expect(200);
    expect(rep.body.averageRating).toBe(4);
  });

  it('rejects invalid input and unknown routes', async () => {
    await request(app).post('/api/v1/contracts').send({ client: 'GA', freelancer: 'GA', milestones: [1] }).expect(400);
    await request(app).get('/api/v1/contracts/999').expect(404);
    await request(app).get('/nope').expect(404);
  });

  it('handles disputes', async () => {
    const { body } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GC', freelancer: 'GD', milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount: 200 });
    await request(app).post(`/api/v1/contracts/${body.id}/dispute`).send({ raisedBy: 'GX' }).expect(403);
    await request(app).post(`/api/v1/contracts/${body.id}/dispute`).send({ raisedBy: 'GD', reason: 'late' }).expect(200);
    const r = await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    expect(r.body.releasedAmount).toBe(100);
    expect(r.body.status).toBe('Resolved');
  });
});

// ---------------------------------------------------------------------------
// Sparse fieldsets (?fields=)
// ---------------------------------------------------------------------------
describe('sparse fieldsets (?fields=)', () => {
  const store = new EscrowStore();
  const created = store.create({
    title: 'Test contract',
    client: 'GA',
    freelancer: 'GB',
    milestones: [{ title: 'Phase 1', amount: 100 }, { title: 'Phase 2', amount: 200 }],
  });
  const app = createApp(store);

  it('GET /contracts returns only requested fields (id always included)', async () => {
    const res = await request(app).get('/api/v1/contracts?fields=title,status').expect(200);
    const contracts: object[] = res.body.data;
    expect(contracts.length).toBeGreaterThan(0);
    contracts.forEach((c) => {
      expect(Object.keys(c).sort()).toEqual(['id', 'status', 'title']);
    });
  });

  it('GET /contracts/:id returns only requested fields', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${created.id}?fields=title,status`)
      .expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['id', 'status', 'title']);
    expect(res.body.id).toBe(created.id);
    expect(res.body.title).toBe('Test contract');
    expect(res.body.status).toBe('Created');
  });

  it('milestones.amount returns milestones with only amount', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${created.id}?fields=milestones.amount`)
      .expect(200);
    expect(res.body.milestones).toBeDefined();
    res.body.milestones.forEach((m: object) => {
      expect(Object.keys(m)).toEqual(['amount']);
    });
    expect(res.body.milestones[0].amount).toBe(100);
    expect(res.body.milestones[1].amount).toBe(200);
  });

  it('unknown field returns 400 with invalid_fields code', async () => {
    const res = await request(app).get('/api/v1/contracts?fields=bogusField').expect(400);
    expect(res.body.error).toBe('invalid_fields');
    expect(res.body.message).toContain('bogusField');
  });

  it('unknown field on single contract returns 400', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${created.id}?fields=title,xyz`)
      .expect(400);
    expect(res.body.error).toBe('invalid_fields');
  });

  it('projection does not mutate the stored contract', async () => {
    // Fetch a sparse view
    await request(app).get(`/api/v1/contracts/${created.id}?fields=title`).expect(200);
    // Subsequent full GET must still return all fields
    const full = await request(app).get(`/api/v1/contracts/${created.id}`).expect(200);
    expect(full.body.milestones).toBeDefined();
    expect(full.body.milestones.length).toBe(2);
    expect(full.body.client).toBe('GA');
    expect(full.body.freelancer).toBe('GB');
  });

  it('omitting ?fields= returns all fields', async () => {
    const res = await request(app).get(`/api/v1/contracts/${created.id}`).expect(200);
    // All required EscrowContract keys should be present
    ['id', 'title', 'client', 'freelancer', 'token', 'milestones', 'totalAmount',
      'fundedAmount', 'releasedAmount', 'status', 'reputationIssued', 'createdAt', 'updatedAt']
      .forEach((k) => expect(res.body).toHaveProperty(k));
  });
});

// ---------------------------------------------------------------------------
// Response compression
// ---------------------------------------------------------------------------
describe('response compression', () => {
  // 200 contracts ensures the response is well above the 1 KB threshold.
  const app = createApp(seededStore(200));

  it('compresses GET /contracts with Accept-Encoding: gzip', async () => {
    // supertest auto-decompresses the body, so we verify the headers and
    // that the parsed body is valid JSON with the expected structure.
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);

    // Body is valid JSON (supertest decompresses automatically)
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(200);
  });

  it('does not compress small responses (< 1 KB) even with Accept-Encoding: gzip', async () => {
    // A 404 response body is tiny and should not be compressed.
    const res = await request(app)
      .get('/nope')
      .set('Accept-Encoding', 'gzip')
      .expect(404);
    // May have Vary header but must NOT have content-encoding: gzip
    expect(res.headers['content-encoding']).not.toBe('gzip');
  });

  it('returns identity encoding when Accept-Encoding: identity is sent', async () => {
    // Explicitly request identity to bypass compression.
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Accept-Encoding', 'identity')
      .expect(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
