/** @file RabbitMQ y EPMD temporales de integración: puertos, nodos, datos y procesos propios, sin afectar brokers existentes. */
'use strict';
const fs             = require('node:fs/promises');
const os             = require('node:os');
const path           = require('node:path');
const net            = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn }      = require('node:child_process');

/**
 * Reserva y libera un puerto efímero de loopback para un proceso exclusivo de esta prueba.
 * @returns {Promise<number>} Puerto disponible en 127.0.0.1.
 */
async function freePort() {
  const server = net.createServer();
  /** @param {Function} resolve Continuación de escucha.
   * @param {Function} reject Fallo al reservar el puerto.
   * @returns {void} Instala los eventos antes de abrir el socket local.
   */
  function listen(resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }
  await new Promise(listen);
  const port = server.address().port;
  /** @param {Function} resolve Continuación después de liberar el puerto.
   * @returns {void} Cierra únicamente el socket temporal creado por esta función.
   */
  function close(resolve) {
    server.close(resolve);
  }
  await new Promise(close);
  return port;
}

/**
 * Espera brevemente entre comprobaciones de disponibilidad sin bloquear el hilo JavaScript.
 * @param {number} milliseconds Duración acotada de la espera.
 * @returns {Promise<void>} Finaliza después del intervalo.
 */
function delay(milliseconds) {
  /** @param {Function} resolve Continuación de la espera.
   * @returns {void} Programa un único temporizador de prueba.
   */
  function wait(resolve) {
    setTimeout(resolve, milliseconds);
  }
  return new Promise(wait);
}

/**
 * Comprueba sólo un puerto de loopback y libera siempre el socket de sondeo.
 * @param {number} port Puerto efímero que pertenece al proceso de prueba.
 * @returns {Promise<boolean>} true si acepta una conexión TCP local.
 */
function listening(port) {
  /** @param {Function} resolve Resultado de la comprobación de disponibilidad.
   * @returns {void} Limita la comprobación a cien milisegundos.
   */
  function probe(resolve) {
    const socket = net.connect({
      host : '127.0.0.1',
      port,
    });
    /** @returns {void} Libera el sondeo después de una conexión correcta. */
    function ready() {
      socket.destroy();
      resolve(true);
    }
    /** @returns {void} Libera el sondeo después de un fallo o una espera vencida. */
    function unavailable() {
      socket.destroy();
      resolve(false);
    }
    socket.once('connect', ready);
    socket.once('error', unavailable);
    socket.setTimeout(100, unavailable);
  }
  return new Promise(probe);
}

/**
 * Detiene exclusivamente el grupo de procesos creado por esta prueba y espera su salida.
 * @param {Object|undefined} child Proceso propio iniciado con detached=true.
 * @returns {Promise<void>} Finaliza tras el cierre o la terminación acotada del proceso propio.
 */
async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  /** @param {string} signal Señal de cierre del grupo exclusivo.
   * @returns {void} Ignora únicamente la ausencia de un proceso ya terminado.
   */
  function signal(signal) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  signal('SIGTERM');
  for (
    let attempt = 0;
    attempt < 50 && child.exitCode === null && child.signalCode === null;
    attempt++
  )
    await delay(100);
  if (child.exitCode === null && child.signalCode === null) {
    signal('SIGKILL');
    for (
      let attempt = 0;
      attempt < 20 && child.exitCode === null && child.signalCode === null;
      attempt++
    )
      await delay(100);
  }
}

/**
 * Inicia un broker sin conexiones ni credenciales de ambientes compartidos.
 * @param {Object} options Binarios explícitos rabbitmqServer y epmd instalados para integración.
 * @returns {Promise<Object>} URL efímera privada y stop idempotente para liberar los recursos propios.
 * @throws {Error} Si no inicia dentro del plazo o un proceso termina antes de estar disponible.
 */
async function startIsolatedAmqp({ rabbitmqServer, epmd }) {
  await fs.access(rabbitmqServer, fs.constants.X_OK);
  await fs.access(epmd, fs.constants.X_OK);
  const directory        = await fs.mkdtemp(path.join(os.tmpdir(), 'solid-amqp-'));
  const amqpPort         = await freePort();
  const distributionPort = await freePort();
  const epmdPort         = await freePort();
  const identifier       = randomUUID().replaceAll('-', '');
  const password         = randomUUID();
  const configuration    = path.join(directory, 'rabbitmq.conf');
  const plugins          = path.join(directory, 'enabled_plugins');
  await fs.writeFile(
    configuration,
    [
      `listeners.tcp.1 = 127.0.0.1:${amqpPort}`,
      'distribution.listener.interface = 127.0.0.1',
      `distribution.listener.port_range.min = ${distributionPort}`,
      `distribution.listener.port_range.max = ${distributionPort}`,
      'disk_free_limit.absolute = 50MB',
      'vm_memory_high_watermark.absolute = 256MiB',
      'log.console = false',
    ].join('\n') + '\n',
  );
  await fs.writeFile(plugins, '[].\n');
  const env = {
    PATH                                : `${path.dirname(epmd)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG                                : 'en_US.UTF-8',
    ERL_EPMD_ADDRESS                    : '127.0.0.1',
    ERL_EPMD_PORT                       : String(epmdPort),
    RABBITMQ_NODENAME                   : `solid_${identifier}@localhost`,
    RABBITMQ_NODE_PORT                  : String(amqpPort),
    RABBITMQ_DIST_PORT                  : String(distributionPort),
    RABBITMQ_ERLANG_COOKIE              : identifier,
    RABBITMQ_CONFIG_FILE                : configuration,
    RABBITMQ_CONF_ENV_FILE              : '/dev/null',
    RABBITMQ_ENABLED_PLUGINS_FILE       : plugins,
    RABBITMQ_MNESIA_BASE                : path.join(directory, 'data'),
    RABBITMQ_LOG_BASE                   : path.join(directory, 'logs'),
    RABBITMQ_PID_FILE                   : path.join(directory, 'rabbit.pid'),
    RABBITMQ_DEFAULT_USER               : 'fixture',
    RABBITMQ_DEFAULT_PASS               : password,
    RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS : `+S 2:2 +A 4 -start_epmd false -setcookie ${identifier}`,
  };
  let epmdChild;
  let brokerChild;
  let stopped = false;
  let output  = '';
  let startupError;
  /** @param {Error} error Fallo al crear exclusivamente uno de los procesos temporales.
   * @returns {void} Conserva el error para rechazar el arranque y ejecutar su cierre.
   */
  function failed(error) {
    startupError = error;
  }
  /** @param {*} chunk Salida técnica acotada de los procesos de prueba.
   * @returns {void} Conserva sólo un diagnóstico temporal sin revelar la credencial efímera.
   */
  function capture(chunk) {
    output = (output + chunk.toString().replaceAll(password, '[fixture]')).slice(-12000);
  }
  /** @returns {Promise<void>} Cierra sólo broker y EPMD propios antes de borrar su directorio temporal. */
  async function stop() {
    if (stopped) return;
    stopped = true;
    await stopProcess(brokerChild);
    await stopProcess(epmdChild);
    await fs.rm(directory, {
      recursive : true,
      force     : true,
    });
  }
  try {
    epmdChild = spawn(epmd, ['-port', String(epmdPort)], {
      env,
      detached : true,
      stdio    : ['ignore', 'pipe', 'pipe'],
    });
    epmdChild.on('error', failed);
    epmdChild.stdout.on('data', capture);
    epmdChild.stderr.on('data', capture);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await listening(epmdPort)) break;
      if (startupError) throw startupError;
      if (epmdChild.exitCode !== null) throw new Error('ISOLATED_EPMD_FAILED:' + output);
      await delay(50);
    }
    if (!(await listening(epmdPort))) throw new Error('ISOLATED_EPMD_TIMEOUT:' + output);
    brokerChild = spawn(rabbitmqServer, [], {
      env,
      cwd      : directory,
      detached : true,
      stdio    : ['ignore', 'pipe', 'pipe'],
    });
    brokerChild.on('error', failed);
    brokerChild.stdout.on('data', capture);
    brokerChild.stderr.on('data', capture);
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await listening(amqpPort))
        return {
          url : `amqp://fixture:${password}@127.0.0.1:${amqpPort}`,
          stop,
        };
      if (startupError) throw startupError;
      if (brokerChild.exitCode !== null) throw new Error('ISOLATED_RABBITMQ_FAILED:' + output);
      await delay(100);
    }
    throw new Error('ISOLATED_RABBITMQ_TIMEOUT:' + output);
  } catch (error) {
    await stop();
    throw error;
  }
}

module.exports = {
  freePort,
  delay,
  stopProcess,
  startIsolatedAmqp,
};
