import assert from 'assert';
import testworker from '../post_task';
import getArtifact from './helper/get_artifact';
import cmd from './helper/cmd';
import expires from './helper/expires';
import TestWorker from '../testworker';
import DockerWorker from '../dockerworker';
import iptables from 'iptables';
import _ from 'lodash';

suite('Directory artifact', function() {
  teardown(() => {
    iptables.deleteRule({
      chain: 'OUTPUT',
      target: 'REJECT',
      protocol: 'tcp',
      dport: 443,
      sudo: true
    });
  });

  test('attempt to upload file as directory', async () => {
    let result = await testworker({
      payload: {
        image: 'taskcluster/test-ubuntu',
        command: cmd('echo "xfoo" > /xfoo.txt'),
        features: {
          // No need to actually issue live logging...
          localLiveLog: false
        },
        artifacts: {
          'public/xfoo': {
            type: 'directory',
            expires: expires(),
            path: '/xfoo.txt'
          }
        },
        maxRunTime: 5 * 60
      }
    });

    // Get task specific results
    assert.equal(result.run.state, 'completed', 'task should be unsuccessful');
    assert.equal(result.run.reasonResolved, 'completed', 'task should be unsuccessful');
    assert.ok(result.artifacts['public/xfoo'], 'artifact should not be present');
    assert.equal(result.artifacts['public/xfoo'].storageType, 'error');
  });

  test('upload an entire directory', async () => {
    let result = await testworker({
      payload: {
        image: 'taskcluster/test-ubuntu',
        command: cmd(
          'mkdir -p "/xfoo/wow"',
          'echo "xfoo" > /xfoo/wow/bar.txt',
          'echo "text" > /xfoo/wow/another.txt',
          'dd if=/dev/zero of=/xfoo/test.html  bs=1  count=1000000'
        ),
        features: {
          localLiveLog: false
        },
        artifacts: {
          'public/dir': {
            type: 'directory',
            path: '/xfoo/',
            expires: expires()
          },
        },
        maxRunTime: 5 * 60
      }
    });

    assert.equal(result.run.state, 'completed', 'task should be successful');
    assert.equal(result.run.reasonResolved, 'completed', 'task should be successful');

    assert.deepEqual(
      Object.keys(result.artifacts).sort(),
      [
        'public/dir/test.html',
        'public/dir/wow/bar.txt',
        'public/dir/wow/another.txt'
      ].sort()
    );

    let bar = await getArtifact(result, 'public/dir/wow/bar.txt');
    let another = await getArtifact(result, 'public/dir/wow/another.txt');

    assert.equal(bar, 'xfoo\n');
    assert.equal(another, 'text\n');

    let testHtml = await getArtifact(result, 'public/dir/test.html');
    assert.ok(Buffer.byteLength(testHtml) === 1000000,
      'Size of uploaded contents of test.html does not match original.'
    );
  });

  test('retry directory upload', async () => {
    // Avoid iptables on local environment
    if (!process.env.WORKER_CI) {
      return;
    }

    this.timeout(480000);

    let ARTIFACT_COUNT = 3;

    let worker = new TestWorker(DockerWorker);
    await worker.launch();

    var count = 0;

    let rejectConnection = function() {
      // Delay iptables rejection to catch
      // in the middle of the upload
      setTimeout(function() {
        iptables.reject({
          chain: 'OUTPUT',
          protocol: 'tcp',
          dport: 443,
          sudo: true
        });
      }, 100);
    }

    let cmdArgs = ['mkdir "/xfoo"'];
    for (let i = 1; i <= ARTIFACT_COUNT; ++i) {
      cmdArgs.push(`dd if=/dev/zero of=/xfoo/test${i}.html bs=1 count=${1000000*i}`);
      worker.once(`Uploading public/dir/test${i}.html`, rejectConnection);
    }

    worker.on('retrying artifact upload', function() {
      iptables.deleteRule({
        chain: 'OUTPUT',
        target: 'REJECT',
        protocol: 'tcp',
        dport: 443,
        sudo: true
      });

      ++count;
    });

    let result = await worker.postToQueue({
      payload: {
        image: 'taskcluster/test-ubuntu',
        command: cmd.apply(this, cmdArgs),
        features: {
          localLiveLog: false
        },
        artifacts: {
          'public/dir': {
            type: 'directory',
            path: '/xfoo/',
            expires: expires()
          },
        },
        maxRunTime: 5 * 60
      }
    });

    await worker.terminate();

    assert.equal(result.run.state, 'completed', 'task should be successful');
    assert.equal(result.run.reasonResolved, 'completed', 'task should be successful');

    let artifacts = [];
    for (let i of _.range(1, ARTIFACT_COUNT+1)) {
      artifacts.push(`public/dir/test${i}.html`);
    }

    assert.deepEqual(
      Object.keys(result.artifacts).sort(),
      artifacts.sort()
    );

    for (let i = 1; i <= ARTIFACT_COUNT; ++i) {
      let testHtml = await getArtifact(result, 'public/dir/test' + i + '.html');
      assert.ok(Buffer.byteLength(testHtml) === 1000000*i,
        'Size of uploaded contents of test.html does not match original.'
      );
    }

    assert.equal(count, ARTIFACT_COUNT, `Count value is ${count}`);
  });
});
