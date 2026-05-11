// Helper to make INSERT queries work for both SQLite and PostgreSQL
const isPostgres = !!(process.env.DATABASE_URL);

// Wrap INSERT query to return id for both databases
const insertQuery = async (queryFn, sql, params) => {
  if (isPostgres) {
    // Add RETURNING id for PostgreSQL
    const pgSql = sql.trim().endsWith(')') ? sql + ' RETURNING id' : sql;
    const [result] = await queryFn(pgSql, params);
    return [{ insertId: result?.rows?.[0]?.id || result?.insertId }];
  }
  return queryFn(sql, params);
};

module.exports = { insertQuery, isPostgres };
