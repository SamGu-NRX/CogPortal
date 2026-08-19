---
jupyter:
  jupytext:
    notebook_metadata_filter: nbsphinx,-kernelspec
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.6
  nbsphinx:
    execute: never
---

<!-- #region -->
# Training a Two-Layer Neural Network on Cifar-10

The tendril classification problem had us construct a single layer neural network to tackle a simple classification problem on shape-$(2,)$ input data. In this notebook, we will work with an dataset of images. We will be using the famed [cifar-10 dataset](https://www.cs.toronto.edu/~kriz/cifar.html), so that our  model can classify pictures of cars, planes, cats, dogs, frogs, and other items. There are 10 classes in total represented in this dataset.
Each image is an a shape-``(3, 32, 32)`` array, corresponding to 32 x 32 RGB values. $3 \times 32 \times 32 = 3072$ thus each image is a vector of length $3072$.

We will be training a two-layer neural network. Our loss function is the cross-entropy loss. The first two layers will use the ReLU activation function and the last layer will use softmax activation. 


#### The Model in Full

\begin{equation}
D_1(x) = \operatorname{ReLU}(xW_{1} + b_{1})\\
D_2(x) = \operatorname{ReLU}(D_1(x) W_{2} + b_{2})\\
F(\{W\}, \{b\}; x) = \operatorname{softmax}(D_2(x) W_3)
\end{equation}


We will again be using the popular cross-entropy classification loss. Keep in mind that `mygrad`, and other auto-differentiation libraries, provide a convenient softmax_crossentropy function, which efficiently computes the softmax *and then* the cross-entropy.
So take care to not apply the softmax function in your model's forward pass.
<!-- #endregion -->

```python
import matplotlib.pyplot as plt

import mygrad as mg
import numpy as np

%matplotlib notebook
```

Running the following cell will download and load the CIFAR10 dataset.
As you will see, it consists of a training dataset of 50,000 images and a test set of 10,000 images.

```python
import cog_datasets

cog_datasets.download_cifar10()

x_train, y_train, x_test, y_test = cog_datasets.load_cifar10()

print('Training data shape: ', x_train.shape)
print('Training labels shape: ', y_train.shape)
print('Test data shape: ', x_test.shape)
print('Test labels shape: ', y_test.shape)
print(x_train.dtype)
```

Let's investigate what our data looks like at a glance. The following cell will plot some examples from each of the 10 classes in our dataset.

```python
classes = ['plane', 'car', 'bird', 'cat', 'deer', 'dog', 'frog', 'horse', 'ship', 'truck']
num_classes = len(classes)
samples_per_class = 7
for y, cls in enumerate(classes):
    idxs = np.flatnonzero(y_train == y)
    idxs = np.random.choice(idxs, samples_per_class, replace=False)
    for i, idx in enumerate(idxs):
        plt_idx = i * num_classes + y + 1
        plt.subplot(samples_per_class, num_classes, plt_idx)
        plt.imshow(x_train[idx].transpose(1,2,0).astype('uint8'))
        plt.axis('off')
        if i == 0:
            plt.title(cls)
plt.show()
```

We will need to do three things to the images in the train and test sets:
- Change the datatypes of the arrays to be 32-bit floating point numbers instead of 8-bit unsigned integers. Recall that `arr = arr.astype("float32")` will update the array's data type.
- Reshape each set of images from a shape-(N, 3, 32, 32) to a  shape-(N, 3072) array. Recall that `arr = arr.reshape(len(arr), -1)` will "flatten" each image in the stack of `N` images to a vector of the appropriate length (`-1` tells numpy to compute this value for you).
- Normalize each image so that each image has a mean pixel value of 0 and a standard deviation of 1.

```python
# Reshape the train and test data to be shape (N, 3072)  (N=50,000 for train, N=10,000 for test)

# For both sets of images – x_train and x_test – update the data type of the array
# to by float-32. Also reshape the array from (N, 3, 32, 32) to (N, 3072)
x_train = x_train.reshape(len(x_train), -1).astype(np.float32) # <COGSTUB>
x_test = x_test.reshape(len(x_test), -1).astype(np.float32)  # <COGSTUB>

# Using only the training data, compute the mean-image (a shape-(3072,) array)
# and the std-dev image (also shape-(3072,) array)
#
# That is, we are computing the mean 1st pixel over all images, the mean 2nd pixel,
# and so on, creating a shape-(3072,) array of these mean pixel values.
#
# Given that x_train is a shape-(N, 3072) array – corresponding to N pictures each with 3,072 pixels – 
# how can we comput the pixel-wise mean and std? 
# Hint: x_train.mean(axis=???) and x_train.std(axis=???)
mean_image = x_train.mean(axis=0)  # <COGSTUB>
std_image = x_train.std(axis=0)  # <COGSTUB>


# Perform a pixel-wise normalization of the training data: x_train = (x_train - mean_image) / std_image
# <COGINST>
x_train -= mean_image
x_train /= std_image
# </COGINST>

# Using the *same* mean and std statistics, do a pixel-wise normalization of the testing
# data: x_test = (x_test - mean_image) / std_image
#
# It is important that we always use the identical normalization/augmentation process on
# our test data as we used on our training data
# <COGINST>
x_test -= mean_image
x_test /= std_image
# </COGINST>
```

Now, let's construct our model using `MyNN` and define our [accuracy function](https://www.pythonlikeyoumeanit.com/Module3_IntroducingNumpy/Problems/ComputeAccuracy.html).

We can experiment with the sizes of our layers, but try:
 
- layer-1: size-100
- layer-2: size-50
- layer-3: size-? (hint: we don't get to pick this)
  - This final layer should not have any bias: `dense(..., bias=False)`
  - We will be using `softmax_crossentropy` for our loss, we don't need an activation function for this last layer.

Use the `he_normal` initialization for each layer.

```python
from mygrad.nnet.initializers.he_normal import he_normal
from mygrad.nnet.activations.relu import relu
from mygrad.nnet.losses import softmax_crossentropy

from mynn.optimizers.sgd import SGD
from mynn.layers.dense import dense


# Define your MyNN-`Model` class here. It should have:
# - an `__init__` method that initializes all of your layers
# - a `__call__` method that defines the model's "forward pass"
# - a `parameters` property that returns a tuple of all of your
#   model's learnable parameters (refer to the Tendrils-MyNN)
#   notebook for the syntax of defining a class-property)
class Model:
    def __init__(self, n1, n2, num_pixels, num_classes):
        """
        Initializes a model with two hidden layers of size `n1` and `n2`
        respectively.
        
        Parameters
        ----------
        n1 : int
            The number of neurons in the first hidden layer

        n2 : int
            The number of neurons in the second hidden layer
        
        num_pixels : int
            The number of pixels in a *single* image

        num_classes : int
            The number of classes predicted by the model"""
        
        # Use the `dense` class from mynn to create three dense layers.
        #
        # Each layer should use the he-normal initialization scheme (same as the last notebook)
        
        # The shape of dense1, which is associated with W_1, should be shape-(??, ??)
        # 
        # Keep in mind that we will be doing the matrix multiplication: X W_1
        # If:
        #   - X has shape-(M, D) where M is batch-size and D is num_pixels per image,
        #   - Our first dense layer should produce a total of n1 outputs
        # then what should the shape of this dense layer be?
        self.dense1 = dense(num_pixels, n1, weight_initializer=he_normal)  # <COGSTUB>
        
        # Create a shape-(n1, n2) dense layer: it takes in n1 inputs from the preceding layer and
        # produces n2 outputs -- one for each of its neurons
        self.dense2 = dense(n1, n2, weight_initializer=he_normal)  # <COGSTUB>
        
        # For our output layer, create a shape-(n2, ???) dense layer
        # Given this particular classification problem, what must the output size of this
        # layer be?
        self.dense3 = dense(n2, num_classes, weight_initializer=he_normal, bias=False)  # <COGSTUB> make sure to set `bias=False` for this one

    def __call__(self, x):
        """ Performs a "forward-pass" of data through the network.
        
        This allows us to conveniently initialize a model `m` and then send data through it
        to be classified by calling `m(x)`.
        
        Parameters
        ----------
        x : Union[numpy.ndarray, mygrad.Tensor], shape=(M, 3072)
            A batch of data consisting of M pieces of data,
            each with a dimentionality of 3072 (the number of
            values among all the pixels in a given image).
            
        Returns
        -------
        mygrad.Tensor, shape-(M, num_class)
            The model's prediction for each of the M images in the batch,
        """
        # Use the model's three dense layers and the relu activation function
        # to process the input:
        # x -> dense1 -> relu -> dense2 -> relu -> dense3 -> out
        # 
        # Note that the output of dense3 does not pass through a relu!
        return self.dense3(relu(self.dense2(relu(self.dense1(x)))))  # <COGLINE>

    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model.
        
        Returns
        -------
        List[mygrad.Tensor]
            A list of all of the model's trainable parameters 
        """
        # return a list of parameters from each of your model's three layers
        return (self.dense1.parameters + self.dense2.parameters + self.dense3.parameters)  # <COGLINE>


# Define your classification-accuracy function
def accuracy(predictions, truth):
    """
    Returns the mean classification accuracy for a batch of predictions.
    
    Parameters
    ----------
    predictions : Union[numpy.ndarray, mg.Tensor], shape=(M, D)
        The scores for D classes, for a batch of M data points

    truth : numpy.ndarray, shape=(M,)
        The true labels for each datum in the batch: each label is an
        integer in [0, D)
    
    Returns
    -------
    float
    """
    # use the solution from your previous notebooks
    return np.mean(np.argmax(predictions, axis=1) == truth)  # <COGLINE>
```

```python
# Creating a noggin plot, that keeps track of the metrics: "loss" and "accuracy"
from noggin import create_plot

plotter, fig, ax = create_plot(metrics=["loss", "accuracy"], last_n_batches=int(5e3))
```

Initialize your model and optimizer, using SGD from MyNN. Specify the parameters, learning rate and weight_decay for your 
optimizer.

A learning rate of $0.1$ and a weight decay of $5\times10^{-4}$ is sensible

```python
model = Model(n1=100, n2=50, num_pixels=x_train.shape[1], num_classes=10)  # <COGSTUB> create a model with 100 neurons in layer 1 and 50 neurons in layer 2. What is the number of classes?

# Be sure to pass your model's parameters to the optimizer 
optim = SGD(model.parameters, learning_rate=0.1, weight_decay=5e-4)  # <COGSTUB> use SGD with a lr of 0.1 and weight_decay of 5e-4

```

Now write code to train your model! Experiment with your learning rate and weight_decay.

```python
# The number of predictions that we will make in each training step
batch_size = 100  # <COGSTUB> Set to 100


# We will train for 10 epochs; you can change this if you'd like.
# You will likely want to train for much longer than this
for epoch_cnt in range(10):
    
    # Create the indices to index into each image of your training data
    # e.g. `array([0, 1, ..., 9999])`, and then shuffle those indices.
    # We will use this to draw random batches of data
    idxs = np.arange(len(x_train))  # -> array([0, 1, ..., 9999])
    np.random.shuffle(idxs)  
    
    for batch_cnt in range(0, len(x_train) // batch_size):
        # Index into `x_train` to get your batch of M images.
        batch_indices = idxs[batch_cnt*batch_size : (batch_cnt + 1)*batch_size]  # <COGSTUB>
        batch = x_train[batch_indices]  #  <COGSTUB> use `batch_indices` to get the random batch of our training data
        
        # compute the predictions for this batch using your model
        prediction = model(batch)  # <COGSTUB>
        

        # use `batch_indices` to get the true values (i.e. labels) for this training batch 
        truth = y_train[batch_indices]  # <COGSTUB>
        

        # compute the loss associated with our predictions vs the truth
        # (use softmax_cross_entropy)
        loss = softmax_crossentropy(prediction, truth)  # <COGSTUB>


        # Use mygrad compute the derivatives for your model's parameters, so
        # that we can perform gradient descent.
        loss.backward()  # <COGLINE>
        

        # perform a step of gradient descent using the optimizer
        optim.step()  # <COGLINE>
        
        
        # compute the accuracy between the prediction and the truth 
        acc = accuracy(prediction, truth)  # <COGSTUB>
        

        plotter.set_train_batch({"loss" : loss.item(),
                                 "accuracy" : acc},
                                 batch_size=batch_size)
    
    # After each epoch we will evaluate how well our model is performing
    # on data from cifar10 *that it has never "seen" before*. This is our
    # "test" data. The measured accuracy of our model here is our best 
    # estimate for how our model will perform in the real world 
    # (on 32x32 RGB images of things in this class)
    test_idxs = np.arange(len(x_test))  # no need to shuffle these!
    
    # Iterates over all `batch_size`-sized batches of our test data
    for batch_cnt in range(0, len(x_test)//batch_size):
        batch_indices = test_idxs[batch_cnt*batch_size : (batch_cnt + 1)*batch_size]  # <COGSTUB> get the next batch of `test_idxs`
        
        batch = x_test[batch_indices]   # <COGSTUB> use `batch_indices` to get the batch of our **test data**
        truth = y_test[batch_indices]  # <COGSTUB> use `batch_indices` to get the batch of our **test labels**
        
        # We do not want to compute gradients here, so we use the
        # no_autodiff context manager to disable the ability to
        with mg.no_autodiff:
            # Get your model's predictions for this test-batch
            # and measure the test-accuracy for this test-batch
            prediction = model(batch)  # <COGSTUB>
            test_accuracy = accuracy(prediction, truth)  # <COGSTUB>
        
        # pass your test-accuracy here; we used the name `test_accuracy`
        plotter.set_test_batch({"accuracy" : test_accuracy}, batch_size=batch_size)
    plotter.set_test_epoch()
```

## Evaluating Your Results


How well is your model performing?
According to the noggin plot, what is the training accuracy of your model? What is the testing accuracy? Is there a gap?

Below, we provide code to randomly pick an image from the test set, plot it, and print your model's predicted label vs the true label. `cog_datasets.load_cifar10.labels` returns a tuple of the label-names in correspondence with each truth-index.

```python
# loading `img_test` for plotting purposes
_, _, img_test, label_test = cog_datasets.load_cifar10()
```

```python
# Run this cell multiple times to see your model's predictions
# for various test images

labels = cog_datasets.load_cifar10.labels  # tuple of cifar-10 labels

index = np.random.randint(0, len(img_test))  # pick a random test-image index

true_label_index = label_test[index]
true_label = labels[true_label_index]

with mg.no_autodiff:
    prediction = model(x_test[index:index + 1])  # passing in a shape-(1, 3072) array 
    predicted_label_index = np.argmax(prediction.data, axis=1).item()  # largest score indicates the prediction
    predicted_label = labels[predicted_label_index]


fig, ax = plt.subplots()

# matplotlib wants shape-(H, W, C) images, with unsigned 8bit pixel values
img = img_test[index].transpose(1, 2, 0).astype('uint8')

ax.imshow(img)
ax.set_title(f"Predicted: {predicted_label}\nTruth: {true_label}");
```

<!-- #region -->
Can you understand some of the mistakes that your model is making? Perhaps it sees a white airplane flying over water, and confuses it for a boat. Can *you* figure out what some of these images depict? Some are pretty hard to identify, given the low resolution. 

To get a more comprehensive understanding of where our model is getting things right and what mistakes it is making, let's plot a **confusion matrix**.
We will have our model make predictions for all of the images in our test set, and we will compare these predictions to the images' true labels.
The confusion matrix will display true labels on its vertical axis and the predicted labels (sorted in the same order) on the horizontal axis. Thus, if you want to see how often our model mistakes a car for a truck, you would find the "car" label on the vertical axis, and the "truck" label on the horizontal axis.
The square where those labels meet reports the number of car-pictures that our model thought was a truck.
Therefore a *perfect* model, given perfectly labeled data, would produce a confusion matrix where all of the off-diagonal elements are $0$ and only the diagonal squares have any "weight" to them.


Run the following cell to compute the confusion matrix.
Our test set consists of 10,000 images, so it is relatively easy to figure out the proportion represented by each square.
Answer the following questions:
- Which classes is the model most reliable at identifying? What is the best and worst accuracies for a single class?
- Are the model's mistakes seemingly random, or does it tend to confuse classes that resemble each other.
- One thing to consider: the model doesn't explicitly know the difference between foreground and background of an image; does the model easily mistake classes of objects/animals that can appear against similar backgrounds? 
<!-- #endregion -->

```python
# Run this cell to plot the confusion matrix

from sklearn.metrics import ConfusionMatrixDisplay

idxs = np.arange(len(x_test))  # -> array([0, 1, ..., 9999])

predictions = []

for batch_cnt in range(0, len(x_test) // batch_size):

    batch_indices = idxs[batch_cnt*batch_size : (batch_cnt + 1)*batch_size]
    batch = x_test[batch_indices]  # random batch of our training data


    with mg.no_autodiff:
        predictions.append(model(batch))  # you must pass in a shape-(1, 3072) array

predictions = np.argmax(np.concatenate(predictions), -1)  # shape-(N,) array of predicted labels

ConfusionMatrixDisplay.from_predictions(predictions, y_test, display_labels=classes);
```
