import { Database } from 'minato'
import MySQLDriver from '@minatojs/driver-mysql'
import Logger from 'reggol'
import test from '@minatojs/tests'

const logger = new Logger('mysql')

describe('@minatojs/driver-mysql', () => {
  const database = new Database()

  before(async () => {
    logger.level = 3
    await database.connect(MySQLDriver, {
      user: 'koishi',
      password: 'koishi@114514',
      database: 'test',
    })
  })

  after(async () => {
    await database.dropAll()
    await database.stopAll()
    logger.level = 2
  })

  it('pass', async () => {
    database.extend('test', {
      id: 'integer',
      userId: 'integer'
    }, {
      primary: 'id',
      autoInc: true
    })
    await database.create('test', {
      userId: 114514
    })
  })
})
